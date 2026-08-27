import Razorpay from 'razorpay';
import crypto from 'crypto';
import type { OrderStatus, Prisma, RefundRequestStatus } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';
import * as ledgerService from './ledger.service';
import * as realtimeService from './realtime.service';
import * as orderService from './order.service';
import * as notify from './notify.service';
import { isStudentPassActive, PASS_DURATION_MS } from './pricing.service';

/**
 * Payment Service — Razorpay integration with production-grade safety.
 *
 * Implements three critical upgrades:
 *   A. WebhookEvent idempotency — log raw payload, dedup on event.id,
 *      process ledger in same transaction as marking processed.
 *   B. Reconciliation — poll Razorpay API for stuck "pending" orders.
 *   C. Order-creation idempotency — prevent double-charge when student
 *      retries payment during the reconciliation gap window.
 */

/**
 * How long a payment-creation claim is honoured before another request may take
 * it over. Long enough to cover a slow Razorpay round trip, short enough that a
 * crashed request does not leave an order unpayable for long.
 *
 * Exported because the upload path needs the same number: an order whose
 * payment claim is live has had a price quoted to Razorpay from its current
 * files, so those files must not move. The two rules have to agree on when a
 * claim has lapsed, or there is a window where one considers the order claimed
 * and the other considers it free.
 */
export const PAYMENT_CLAIM_TTL_MS = 60 * 1000;

/**
 * How long an unpaid Student Pass checkout holds the one open slot.
 *
 * Not a lock TTL — the slot is held by a row and enforced by a partial unique
 * index, so nothing depends on this number for correctness. It only decides
 * when an unpaid checkout stops being the one the student is offered and a
 * fresh gateway order is minted instead.
 *
 * Fifteen minutes, which is longer than the old five-minute claim precisely
 * because it is no longer a lock. A student returning inside it is handed the
 * *same* Razorpay order rather than a refusal, so a generous window costs them
 * nothing and buys the one thing that matters: while it holds, there is exactly
 * one gateway order in existence and a second capture is impossible.
 *
 * Past it, `createStudentPassOrder` asks the gateway whether the abandoned
 * checkout was paid before minting anything new — the same question
 * `adoptCapturedPayment` asks for a print order — so even the sequential case
 * cannot quietly become two payments.
 */
export const PASS_CHECKOUT_EXPIRY_MS = 15 * 60 * 1000;

/**
 * Who the expiry job acts as.
 *
 * `updateOrderStatus` takes a requester so it can enforce role rules, and a
 * scheduled job has no user behind it. ADMIN is the right role — the job is
 * doing what an operator would — and a synthetic id keeps it distinguishable
 * from a real admin in the notification fan-out, which excludes the actor.
 * Since no student holds this id, the student is always told.
 */
const SYSTEM_ACTOR_ID = 'system:expire-unpaid';

/**
 * Tell the shop a paid order has arrived.
 *
 * Three independent paths move an order into PENDING_APPROVAL — signature
 * verification, the webhook, and reconciliation — and a slow client can make
 * two of them race on the same order. Each guards its write on the previous
 * status and only calls this when its own update actually applied, so the shop
 * is told exactly once no matter which path got there first.
 */
async function announcePaidOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      shopId: true,
      userName: true,
      shop: { select: { ownerUserId: true } },
    },
  });
  if (!order?.shop) return;

  notify.notifyNewOrder({
    id: order.id,
    shopId: order.shopId,
    userName: order.userName,
    ownerUserId: order.shop.ownerUserId,
  });
}

/**
 * Constant-time comparison of two hex digests.
 *
 * `===` on a signature short-circuits at the first differing character, leaking
 * through response timing how much of a guess was correct.
 */
function signaturesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  // timingSafeEqual throws on length mismatch, and length alone is not secret.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Razorpay Client (lazy-initialized) ──
let razorpayClient: InstanceType<typeof Razorpay> | null = null;

function getRazorpay(): InstanceType<typeof Razorpay> {
  if (!razorpayClient) {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw ApiError.internal('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
    }
    razorpayClient = new Razorpay({
      key_id: env.RAZORPAY_KEY_ID,
      key_secret: env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayClient;
}

/**
 * Check that Razorpay answers and that our credentials are accepted.
 *
 * Listing one order is the cheapest authenticated call available: it proves
 * reachability, key validity and secret validity in a single request, and
 * unlike creating anything it leaves no trace on the account.
 *
 * Also reports which mode the key is in, because "payments are failing" and
 * "the server is on test keys" look identical from the outside and are the
 * single most likely launch-day misconfiguration.
 */
export async function probeGateway(): Promise<{ mode: 'live' | 'test'; detail: string }> {
  const mode = env.RAZORPAY_KEY_ID.startsWith('rzp_live_') ? 'live' : 'test';
  await getRazorpay().orders.all({ count: 1 });
  return { mode, detail: `gateway reachable, credentials accepted (${mode} mode)` };
}

// ────────────────────────────────────────────────────────────
// CREATE PAYMENT ORDER
// ────────────────────────────────────────────────────────────

interface CreatePaymentResult {
  razorpayOrderId: string;
  amount: number;      // in paise (₹1 = 100 paise)
  currency: string;
  orderId: string;     // our internal order ID
  key: string;       // Razorpay key ID for frontend
  /**
   * True when this order turned out to be paid already and no checkout should
   * be opened. The client must show a confirmation instead of charging again.
   */
  paid?: boolean;
  /** True when that payment was discovered here rather than already recorded. */
  recovered?: boolean;
  /** Human-readable reason, shown when `paid` is true. */
  message?: string;
}

/**
 * What the gateway had to say about an order we still consider unpaid.
 *
 * `unpaid` and `needs_review` must never be collapsed into one "not recovered"
 * answer. They look similar — neither ends with the order marked paid — but
 * they call for opposite handling: `unpaid` means no money moved and the
 * student may safely be sent back to checkout, while `needs_review` means money
 * *did* move and sending them back to checkout would ask them to pay twice.
 */
type RecoveryOutcome =
  | { outcome: 'recovered'; paymentId: string }
  | { outcome: 'unpaid' }
  | { outcome: 'claimed_elsewhere' }
  | { outcome: 'needs_review'; reason: string };

/**
 * Flag an order as needing a human, and tell the admins — once.
 *
 * The reconciliation sweep revisits the same stuck order every run, so an
 * unguarded alert here would mail the admins about one order every fifteen
 * minutes forever, which trains them to ignore the alert that matters. The
 * marker write is the dedup: `paymentVerifiedVia` is set only when it is not
 * already set to this value, and only the call whose update lands announces.
 */
async function flagForReview(orderId: string, reason: string): Promise<void> {
  const marked = await prisma.order.updateMany({
    where: {
      id: orderId,
      // The NULL arm is load-bearing, and its absence made this whole function
      // a silent no-op for the orders it most needed to flag.
      //
      // The dedup column is null until an order is actually flagged, and SQL
      // three-valued logic means `NULL <> '<reason>'` evaluates to NULL rather
      // than true — so `{ not: ... }` alone matched *zero rows* for any order
      // that had never been flagged, which is every order this exists for.
      // `updateMany` returned count 0, this function returned early, and no
      // console line and no admin alert were ever produced.
      //
      // Found by driving the real endpoint against a real Postgres; a mocked
      // test cannot see it, because the bug is in how SQL treats NULL.
      //
      // The dedup now runs on `needsReviewReason` rather than on
      // `paymentVerifiedVia`. That column records *which path* confirmed a
      // payment — 'signature', 'webhook', 'recovery' — and overwriting it with a
      // flag sentinel destroyed that answer for exactly the orders someone was
      // about to investigate. Keying on the reason also keeps the useful half of
      // the old behaviour: the reconciliation sweep revisiting the same stuck
      // order produces the same sentence and stays silent, while a second,
      // genuinely different problem on that order still announces.
      OR: [
        { needsReviewReason: null },
        { needsReviewReason: { not: reason } },
      ],
    },
    data: { needsReviewReason: reason, flaggedForReviewAt: new Date() },
  });

  if (marked.count === 0) return;

  console.error(`⚠️ Order ${orderId} needs review: ${reason}`);
  notify.notifyAdmins(`Payment on order ${orderId} needs review — ${reason}`, 'warning');
}

/**
 * Adopt a payment Razorpay already captured for an order we still consider
 * unpaid.
 *
 * A capture can end up stranded whenever the client stops listening before the
 * verify call lands — the checkout was dismissed and then the UPI collect was
 * approved a minute later, the app was killed, the network dropped. The money
 * is gone from the student's account either way, so the only question is
 * whether we notice.
 *
 * Guarded on the status we read, so a webhook that arrives while we are talking
 * to Razorpay keeps ownership of the transition and the shop is told once.
 */
async function adoptCapturedPayment(order: {
  id: string;
  status: OrderStatus;
  razorpayOrderId: string;
  totalPrice: number;
}): Promise<RecoveryOutcome> {
  const razorpay = getRazorpay();

  const rpOrder = await razorpay.orders.fetch(order.razorpayOrderId);
  if (rpOrder.status !== 'paid') return { outcome: 'unpaid' };

  const payments = await razorpay.orders.fetchPayments(order.razorpayOrderId);
  const captured = (payments as any).items?.find((p: any) => p.status === 'captured');

  // Razorpay considers the order paid but shows us no captured payment. Money
  // is somewhere in that gap, so this is not a green light to charge again.
  if (!captured) {
    await flagForReview(
      order.id,
      `Razorpay reports order ${order.razorpayOrderId} paid but lists no captured payment`
    );
    return { outcome: 'needs_review', reason: 'the gateway reports this order as paid' };
  }

  // The same check the webhook makes: a capture proves money moved, not that
  // the right amount moved. Anything else is left for a human — and critically,
  // is not treated as "unpaid", because it is not.
  if (captured.amount !== order.totalPrice) {
    await flagForReview(
      order.id,
      `captured ${captured.amount} paise but the order costs ${order.totalPrice} ` +
      `(payment ${captured.id})`
    );
    return { outcome: 'needs_review', reason: 'the amount received does not match this order' };
  }

  const applied = await prisma.order.updateMany({
    where: { id: order.id, status: order.status },
    data: {
      status: 'PENDING_APPROVAL',
      razorpayPaymentId: captured.id,
      paymentVerifiedVia: 'recovery',
    },
  });

  // Another path committed the same transition while we were at the gateway.
  // The order is paid, just not by us — so still never reopen it.
  if (applied.count === 0) return { outcome: 'claimed_elsewhere' };

  await announcePaidOrder(order.id);
  console.log(`🔄 Recovered order ${order.id} from ${order.status} — payment ${captured.id}`);

  return { outcome: 'recovered', paymentId: captured.id as string };
}

/**
 * Create a Razorpay payment order for an existing EzyPrint order.
 *
 * Upgrade C (Order-creation idempotency):
 * If the student already has a Razorpay order for this EzyPrint order
 * (e.g., they refreshed the page, or hit "Pay" twice), we return
 * the existing Razorpay order instead of creating a duplicate.
 * This prevents double-charge during the reconciliation gap window.
 */
export async function createPaymentOrder(
  orderId: string,
  userId: string
): Promise<CreatePaymentResult> {
  const preflight = await prisma.order.findUnique({ where: { id: orderId } });
  if (!preflight) throw ApiError.notFound('Order not found');
  if (preflight.userId !== userId) throw ApiError.forbidden('This is not your order');

  // ── Retrying after a failed attempt ──
  //
  // A failed attempt leaves the order in PAYMENT_FAILED, and every write below
  // — like verify, the webhook and reconciliation — is guarded on
  // PENDING_PAYMENT. Without this the "Retry Payment" button answered "Order is
  // in PAYMENT_FAILED status, not PENDING_PAYMENT" forever, so a declined card
  // or a dismissed UPI prompt made the order permanently unpayable.
  //
  // Ask the gateway before reopening. PAYMENT_FAILED is set by the client the
  // moment the checkout closes, which is a guess about what the student did
  // next: a UPI collect approved after that reads as a failure here and a
  // capture there. Charging again without looking would take the money twice.
  if (preflight.status === 'PAYMENT_FAILED') {
    // Only worth asking when an attempt actually reached the gateway. Without a
    // Razorpay order there is nothing that could have been captured.
    if (preflight.razorpayOrderId) {
      const razorpayOrderId = preflight.razorpayOrderId;

      const recovery = await adoptCapturedPayment({
        id: preflight.id,
        status: preflight.status,
        razorpayOrderId,
        totalPrice: preflight.totalPrice,
      }).catch((error): RecoveryOutcome => {
        // A gateway lookup that fails must not block the retry — the student is
        // standing there wanting to pay. Treating an outage as `unpaid` reopens
        // the order, and the same Razorpay order is reused below, so a capture
        // that did happen is still found by the reconciliation sweep. Razorpay
        // also refuses a second payment against an order it already considers
        // paid, so the gateway itself backstops the double charge.
        console.error(`[payment] could not check ${razorpayOrderId} before retry:`, error);
        return { outcome: 'unpaid' };
      });

      // Anything other than a clean "no money moved" must not send the student
      // back to checkout. `recovered` and `claimed_elsewhere` mean the order is
      // paid; `needs_review` means money moved in a way we cannot reconcile.
      // Reopening on any of them is how one payment becomes two.
      if (recovery.outcome === 'recovered' || recovery.outcome === 'claimed_elsewhere') {
        return {
          razorpayOrderId,
          amount: preflight.totalPrice,
          currency: 'INR',
          orderId,
          key: env.RAZORPAY_KEY_ID,
          paid: true,
          recovered: recovery.outcome === 'recovered',
          message: 'Your earlier payment did go through. The order has been sent to the shop.',
        };
      }

      if (recovery.outcome === 'needs_review') {
        // Deliberately a hard stop rather than a retry. The student is told the
        // truth — their money is accounted for and a human is looking — instead
        // of being invited to pay a second time for an order that already took
        // one payment.
        throw ApiError.conflict(
          `We have found a payment against this order but ${recovery.reason}. ` +
          `Our team has been alerted and will sort this out — please do not pay again.`
        );
      }
    }

    // Genuinely unpaid — reopen it. PAYMENT_FAILED -> PENDING_PAYMENT is
    // already a legal edge in VALID_TRANSITIONS; the payment path just never
    // took it. Any existing Razorpay order is kept and reused: an order stays
    // open across failed attempts, and minting a new one would orphan the old
    // id that a late webhook still refers to.
    const reopened = await prisma.order.updateMany({
      where: { id: orderId, status: 'PAYMENT_FAILED' },
      data: { status: 'PENDING_PAYMENT' },
    });

    if (reopened.count === 0) {
      // Something else moved it while we were at the gateway. Everything below
      // re-reads the row, so it decides on what is true now.
      console.log(`[payment] order ${orderId} left PAYMENT_FAILED during retry setup`);
    }
  }

  // Re-read once the retry path may have reopened the order, so the repricing
  // decision below sees the status this request actually operates on rather
  // than the one it walked in with.
  const current = preflight.status === 'PAYMENT_FAILED'
    ? await prisma.order.findUnique({ where: { id: orderId } })
    : preflight;
  if (!current) throw ApiError.notFound('Order not found');

  // Fast path: a Razorpay order already exists, so hand back the same one.
  if (current.razorpayOrderId && current.status === 'PENDING_PAYMENT') {
    return {
      razorpayOrderId: current.razorpayOrderId,
      amount: current.totalPrice,
      currency: 'INR',
      orderId,
      key: env.RAZORPAY_KEY_ID,
    };
  }

  if (current.status !== 'PENDING_PAYMENT') {
    throw ApiError.badRequest(`Order is in ${current.status} status, not PENDING_PAYMENT`);
  }

  // ── Claim the right to create, atomically, BEFORE anything else ──
  //
  // The read above cannot be trusted on its own: two taps on "Pay" produce two
  // requests that both see razorpayOrderId as null, both call Razorpay, and both
  // create a real order. The second write then overwrites the first's
  // razorpayOrderId, so a payment against the orphaned order arrives on a
  // webhook that matches no row — the student is charged with nothing to show.
  //
  // Setting paymentAttemptedAt from null (or from a stale value) is a
  // compare-and-swap: exactly one concurrent request can win it, and only the
  // winner is allowed to talk to Razorpay.
  const staleClaimCutoff = new Date(Date.now() - PAYMENT_CLAIM_TTL_MS);
  const claim = await prisma.order.updateMany({
    where: {
      id: orderId,
      status: 'PENDING_PAYMENT',
      razorpayOrderId: null,
      // Reclaimable if a previous attempt died before recording its result,
      // otherwise a crash would strand the order permanently unpayable.
      OR: [
        { paymentAttemptedAt: null },
        { paymentAttemptedAt: { lt: staleClaimCutoff } },
      ],
    },
    data: { paymentAttemptedAt: new Date() },
  });

  if (claim.count === 0) {
    // Lost the race. Either the winner has already recorded its Razorpay order
    // (return it — this is the genuine idempotent hit), or it is still in
    // flight and the client should retry in a moment.
    const winner = await prisma.order.findUnique({ where: { id: orderId } });
    if (winner?.razorpayOrderId) {
      return {
        razorpayOrderId: winner.razorpayOrderId,
        amount: winner.totalPrice,
        currency: 'INR',
        orderId,
        key: env.RAZORPAY_KEY_ID,
      };
    }
    throw ApiError.conflict('A payment is already being set up for this order. Please try again in a moment.');
  }

  /**
   * Hand the order back so the student can retry immediately rather than
   * waiting out the stale-claim TTL.
   *
   * Every exit between here and the moment `razorpayOrderId` is recorded has to
   * go through this, because the claim is what freezes the order's files: a
   * claim left behind by a refusal locks the student out of fixing the very
   * thing they were refused for.
   */
  const releaseClaim = async () => {
    await prisma.order
      .updateMany({ where: { id: orderId, razorpayOrderId: null }, data: { paymentAttemptedAt: null } })
      .catch((error) => console.error(`[payment] could not release the claim on ${orderId}:`, error));
  };

  // ── Price the order from pages the server counted, before charging ──
  //
  // `pageCount` reaches the order from the browser and is the multiplier in
  // `pageCount × rate × copies`. Every other pricing input already comes from
  // the database; this is the last one that did not, and understating it
  // understated the bill — a 200-page PDF declared as one page was charged as
  // one page and printed as two hundred.
  //
  // Inside the claim, deliberately. This used to run *before* it, and the
  // fingerprint that certifies "these are the files that price was computed
  // from" was written *after* it — so the two straddled the one thing that
  // freezes an order's files. An upload committing in that gap was allowed by
  // the upload guard (no claim yet, no razorpayOrderId yet) and left the price
  // describing the old file set while the fingerprint described the new one.
  // Both downstream checks then passed on a swapped document: the captured
  // amount still equalled `totalPrice`, and `pricedFilesUnchanged` still
  // matched. Everything from here to the `razorpayOrderId` write now happens
  // with the files held.
  const repriced = await orderService.repriceFromVerifiedPages(orderId);

  if (repriced.unverifiable.length > 0) {
    await releaseClaim();
    throw ApiError.badRequest(
      `We could not read the page count for ${repriced.unverifiable.join(', ')}. ` +
      `Please re-upload ${repriced.unverifiable.length > 1 ? 'these files' : 'this file'} before paying.`
    );
  }

  // If it moves we stop rather than charging the corrected figure: the amount
  // taken must be the amount that was on screen when they agreed to it.
  if (repriced.changed) {
    await releaseClaim();
    throw ApiError.conflict(
      `The page count for this order was different from what was submitted, so the ` +
      `total is now ₹${(repriced.totalPrice / 100).toFixed(2)} instead of ` +
      `₹${(repriced.previousTotal / 100).toFixed(2)}. Please review and pay again.`
    );
  }

  // Read under the claim, so this is the figure the fingerprint below belongs to.
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.userId !== userId) throw ApiError.forbidden('This is not your order');

  if (order.totalPrice < 100) {
    await releaseClaim();
    throw ApiError.badRequest('Minimum order amount is ₹1');
  }

  // Hashed here rather than after the gateway call, from the same held state the
  // price was just read from. The claim does hold across the round trip — the
  // upload guard refuses while it is live — but it lapses at
  // PAYMENT_CLAIM_TTL_MS, and a gateway call slower than that would reopen the
  // exact gap this ordering exists to close. Taking both figures from one moment
  // means the fingerprint cannot describe a file set the amount was not computed
  // from, whatever Razorpay does with the time in between.
  const pricedFilesFingerprint = await orderService.fingerprintPricedFiles(prisma, orderId);

  const razorpay = getRazorpay();

  let rpOrder: { id: string };
  try {
    rpOrder = await razorpay.orders.create({
      amount: order.totalPrice,
      currency: 'INR',
      receipt: orderId,
      notes: {
        orderId,
        userId,
        shopId: order.shopId,
      },
    });
  } catch (error) {
    await releaseClaim();
    throw error;
  }

  // Guarded write: the unique constraint on razorpayOrderId is the DB-level
  // backstop, and `razorpayOrderId: null` here means we never clobber a value
  // another request somehow recorded first.
  //
  // The fingerprint lands in the same statement as the id, because they record
  // the same fact from two sides: this is the moment the price stopped being
  // negotiable, and this is the file set it was computed from. Written together
  // or not at all — an id without a fingerprint would be an order nobody can
  // later verify, which is the state this column exists to remove.
  const recorded = await prisma.order.updateMany({
    where: { id: orderId, razorpayOrderId: null },
    data: {
      razorpayOrderId: rpOrder.id,
      pricedFilesFingerprint,
    },
  });

  if (recorded.count === 0) {
    // Should be unreachable given the claim above. If it happens, the Razorpay
    // order we just created is orphaned — log it loudly so it can be reconciled
    // rather than silently returning an ID the DB does not know about.
    console.error(
      `⚠️ Orphaned Razorpay order ${rpOrder.id} for EzyPrint order ${orderId} — ` +
      `another request recorded a different Razorpay order first.`
    );
    const current = await prisma.order.findUnique({ where: { id: orderId } });
    if (current?.razorpayOrderId) {
      return {
        razorpayOrderId: current.razorpayOrderId,
        amount: current.totalPrice,
        currency: 'INR',
        orderId,
        key: env.RAZORPAY_KEY_ID,
      };
    }
    throw ApiError.internal('Could not attach the payment to this order.');
  }

  return {
    razorpayOrderId: rpOrder.id,
    amount: order.totalPrice,
    currency: 'INR',
    orderId,
    key: env.RAZORPAY_KEY_ID,
  };
}

// ────────────────────────────────────────────────────────────
// VERIFY PAYMENT (client-side callback)
// ────────────────────────────────────────────────────────────

interface VerifyPaymentInput {
  orderId: string;
  razorpayPaymentId: string;
  razorpayOrderId: string;
  razorpaySignature: string;
}

/**
 * Verify Razorpay payment signature and update order status.
 *
 * Upgrade C (continued): If the order is already PENDING_APPROVAL
 * (i.e., the webhook beat the client callback), return success
 * idempotently instead of throwing an error.
 */
export async function verifyPayment(
  input: VerifyPaymentInput,
  userId: string
) {
  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = input;

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.userId !== userId) throw ApiError.forbidden('This is not your order');

  // ── Upgrade C: Idempotent verify ──
  // If the webhook already processed this payment, return success.
  if (order.status === 'PENDING_APPROVAL' && order.razorpayPaymentId === razorpayPaymentId) {
    return order;
  }

  if (order.status !== 'PENDING_PAYMENT') {
    throw ApiError.badRequest('Order is not awaiting payment');
  }

  if (order.razorpayOrderId !== razorpayOrderId) {
    throw ApiError.badRequest('Razorpay order ID mismatch');
  }

  // Verify signature using HMAC SHA-256
  const body = razorpayOrderId + '|' + razorpayPaymentId;
  const expectedSignature = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  if (!signaturesMatch(expectedSignature, razorpaySignature)) {
    await prisma.order.updateMany({
      where: { id: orderId, status: 'PENDING_PAYMENT' },
      data: {
        status: 'PAYMENT_FAILED',
        paymentVerifiedVia: 'signature_mismatch',
      },
    });
    throw ApiError.badRequest('Payment verification failed — signature mismatch');
  }

  // The signature proves Razorpay collected this payment against this order. It
  // says nothing about the order still describing the same work, so the same
  // file-set check the webhook makes applies here too — this path reaches the
  // identical PENDING_APPROVAL transition, and guarding one and not the other
  // would just move the hole to whichever confirmation arrived first.
  if (!(await orderService.pricedFilesUnchanged(prisma, order))) {
    const enforceFingerprint = env.FINGERPRINT_VERIFY === 'enforce';

    await flagForReview(
      orderId,
      `the files changed after the price was set — signature-verified payment ${razorpayPaymentId} ` +
      `is for a different file set than the order now holds` +
      (enforceFingerprint ? '' : ' [FINGERPRINT_VERIFY=log — fulfilled anyway]')
    );

    if (enforceFingerprint) {
      throw ApiError.conflict(
        'The files on this order changed after its price was set, so we have not sent it to the shop. ' +
        'Your payment is safe and our team has been alerted.'
      );
    }
  }

  // Guarded on the status read above. The webhook path may have committed the
  // same transition in the meantime; an unguarded update would overwrite what it
  // wrote instead of deferring to it.
  const applied = await prisma.order.updateMany({
    where: { id: orderId, status: 'PENDING_PAYMENT' },
    data: {
      status: 'PENDING_APPROVAL',
      razorpayPaymentId,
      paymentVerifiedVia: 'signature',
    },
  });

  if (applied.count === 1) await announcePaidOrder(orderId);

  const updatedOrder = await prisma.order.findUnique({ where: { id: orderId } });
  if (!updatedOrder) throw ApiError.notFound('Order not found');

  return updatedOrder;
}

// ────────────────────────────────────────────────────────────
// WEBHOOK — Upgrade A: Idempotent, logged, transactional
// ────────────────────────────────────────────────────────────

/**
 * Handle Razorpay webhook events with production-grade safety.
 *
 * The flow is:
 *   1. Verify HMAC signature (reject fakes before any DB work)
 *   2. Extract event.id — this is Razorpay's unique event identifier
 *   3. INSERT into WebhookEvent with unique constraint on eventId
 *      - If duplicate → skip (idempotent)
 *   4. Process business logic (update order status)
 *   5. Mark WebhookEvent as processed in the SAME transaction
 *   6. Return 200 to Razorpay immediately
 *
 * If step 4 crashes, the WebhookEvent exists with processed=false.
 * The reconciliation job (Upgrade B) will pick it up.
 */
export async function handleWebhook(
  rawBody: string,
  signature: string,
  webhookSecret: string,
  /**
   * Value of the `X-Razorpay-Event-Id` header.
   *
   * Razorpay puts the event's unique id in this header, not in the JSON body —
   * the body has `entity`, `event`, `payload`, `created_at` and no top-level
   * `id`. Reading `event.id` therefore always found undefined, so every real
   * delivery was rejected as malformed and no webhook was ever processed.
   */
  headerEventId?: string
) {
  // Step 1: Verify signature BEFORE any DB work
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  if (!signaturesMatch(expectedSignature, signature)) {
    throw ApiError.unauthorized('Invalid webhook signature');
  }

  const event = JSON.parse(rawBody);
  // The header is the real source; `event.id` is only a fallback for callers
  // that synthesise a payload (the reconciliation job, tests).
  const eventId = headerEventId || event.id;
  const eventType = event.event;

  if (!eventId) {
    throw ApiError.badRequest('Webhook missing event id (X-Razorpay-Event-Id header)');
  }

  // Step 2/3: Record the event, idempotently.
  //
  // Razorpay double-delivers on occasion. A findUnique-then-create would let two
  // concurrent deliveries both see "not present" and both insert, and the loser's
  // unique-constraint violation would surface as a 500 that prompts yet another
  // retry. An upsert collapses the check and the insert into one statement, so
  // the duplicate is absorbed instead of erroring.
  const rpOrderId = event.payload?.payment?.entity?.order_id || null;

  await prisma.webhookEvent.upsert({
    where: { eventId },
    create: {
      source: 'razorpay',
      eventId,
      eventType,
      razorpayOrderId: rpOrderId,
      payload: event,
    },
    update: {}, // already recorded — leave the original payload untouched
  });

  // Claim the right to process it, atomically.
  //
  // The upsert absorbs a duplicate INSERT, but `processed` alone cannot
  // serialize two concurrent deliveries: it is read here and written at the end
  // of `processWebhookEvent`, so a redelivery arriving mid-processing saw
  // `false` — as the first delivery had — and ran the whole handler a second
  // time. The order writes are guarded on status and the ledger dedupes on
  // eventId, so money stayed correct, but both deliveries hit Razorpay and both
  // notified. Claiming closes the window rather than relying on those.
  if (!(await claimWebhookEvent(eventId))) {
    return { received: true, status: 'already_processed' };
  }

  // Step 4+5: Process and mark as processed in a single transaction
  try {
    await processWebhookEvent(eventType, event, eventId);
  } catch (error) {
    // Log the error but still return 200 to Razorpay so it stops retrying.
    // The reconciliation job will pick up unprocessed events.
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await releaseWebhookClaim(eventId, errorMessage);
    console.error(`⚠️ Webhook processing failed for event ${eventId}:`, errorMessage);
    return { received: true, status: 'processing_failed' };
  }

  return { received: true, status: 'processed' };
}

/**
 * How long a processing claim is honoured before another caller may take it.
 *
 * Long enough for the slowest handler (a transaction plus a gateway round
 * trip), short enough that a process killed mid-handler does not strand the
 * event until the next reconciliation sweep.
 */
const WEBHOOK_CLAIM_TTL_MS = 2 * 60 * 1000;

/** Failed attempts after which an event is escalated instead of retried. */
const MAX_WEBHOOK_ATTEMPTS = 10;

/**
 * Take exclusive ownership of an unprocessed event.
 *
 * Compare-and-swap on `claimedAt`, the same shape `createPaymentOrder` uses for
 * `paymentAttemptedAt`: exactly one concurrent caller can win, and a claim
 * older than the TTL is reclaimable so a crash cannot block the event forever.
 */
async function claimWebhookEvent(eventId: string): Promise<boolean> {
  const staleCutoff = new Date(Date.now() - WEBHOOK_CLAIM_TTL_MS);

  const claim = await prisma.webhookEvent.updateMany({
    where: {
      eventId,
      processed: false,
      OR: [{ claimedAt: null }, { claimedAt: { lt: staleCutoff } }],
    },
    data: { claimedAt: new Date() },
  });

  return claim.count === 1;
}

/**
 * Record a failed attempt and release the claim so a retry can pick it up.
 *
 * Escalates once when the attempt budget is exhausted. Without that an event
 * that can never be processed — a malformed payload, a refund whose request row
 * is gone — was re-attempted by every reconciliation pass forever, and nobody
 * was ever told.
 */
async function releaseWebhookClaim(eventId: string, errorMessage: string): Promise<void> {
  const updated = await prisma.webhookEvent.update({
    where: { eventId },
    data: {
      processingError: errorMessage,
      attempts: { increment: 1 },
      claimedAt: null,
    },
    select: { attempts: true, eventType: true },
  });

  if (updated.attempts === MAX_WEBHOOK_ATTEMPTS) {
    console.error(
      `⚠️ Webhook event ${eventId} (${updated.eventType}) has failed ` +
      `${MAX_WEBHOOK_ATTEMPTS} times and will no longer be retried: ${errorMessage}`
    );
    notify.notifyAdmins(
      `A Razorpay webhook (${updated.eventType}, event ${eventId}) has failed ` +
      `${MAX_WEBHOOK_ATTEMPTS} times and has been given up on. It needs a human: ${errorMessage}`,
      'error'
    );
  }
}

/**
 * Process a single webhook event. Called from both the webhook handler
 * and the reconciliation job. Uses a Prisma transaction to atomically
 * update the order AND mark the webhook as processed.
 */
/**
 * Locate the RefundRequest a Razorpay refund webhook refers to.
 *
 * Prefers the refund id we stored when initiating. Falls back to the payment
 * id, which is what makes the `refund.processed` recovery path work at all —
 * in that case the local transaction never committed, so no refund id was
 * ever persisted to match on.
 */
async function findRefundRequest(tx: any, refund: { id: string; payment_id?: string }) {
  const byRefundId = await tx.refundRequest.findFirst({
    where: { razorpayRefundId: refund.id },
  });
  if (byRefundId) return byRefundId;

  if (!refund.payment_id) return null;

  return tx.refundRequest.findFirst({
    where: { order: { razorpayPaymentId: refund.payment_id } },
  });
}

/**
 * Everyone who needs telling once a refund reaches its terminal state.
 *
 * Returned rather than notified in place because both callers below run inside
 * a transaction, and a notification sent from there would announce an outcome
 * that a rollback can still take back.
 */
interface RefundParty {
  studentUserId: string;
  orderId: string;
  shopId: string;
}

/**
 * Apply a confirmed refund to the request, the order and the shop's ledger.
 *
 * Extracted from the `refund.processed` webhook so the reconciliation poll in
 * `reconcileStuckRefunds` applies the identical effects. Two implementations of
 * "the refund landed" is how the push path and the pull path drift into
 * disagreeing about what a settled refund looks like — and the pull path is the
 * one that runs when the webhook was never configured, so it is exactly the
 * copy that would rot unnoticed.
 *
 * Returns who to tell, or null when this call was not the one that moved the
 * row — a redelivery, or the poll racing the webhook it exists to replace.
 *
 * The ledger write reuses `refund:<id>` as its eventId, so an entry made by
 * whichever path arrived first is found rather than duplicated.
 */
async function applyRefundProcessed(
  tx: Prisma.TransactionClient,
  request: {
    id: string;
    orderId: string;
    shopId: string;
    status: RefundRequestStatus;
    attempts: number;
  },
  refund: { id: string; amount: number },
  outboxIds: string[]
): Promise<RefundParty | null> {
  if (request.status !== 'PROCESSING_REFUND') return null;

  const moved = await tx.refundRequest.updateMany({
    where: { id: request.id, status: 'PROCESSING_REFUND' },
    data: {
      status: 'RESOLVED_REFUNDED',
      razorpayRefundId: refund.id,
      adminResolvedAt: new Date(),
      refundAmount: refund.amount,
    },
  });

  // Record the refund on the order regardless of what terminal state it
  // holds. This is the moment `refundStatus` earns the word 'processed' — it
  // is written here, on Razorpay's confirmation, rather than at acceptance
  // where it used to be a guess.
  await tx.order.updateMany({
    where: { id: request.orderId },
    data: {
      refundId: refund.id,
      refundStatus: ledgerService.ORDER_REFUND_STATUS.processed,
      refundAmount: refund.amount,
      refundedAt: new Date(),
    },
  });

  // Promoting the order to REFUNDED is separate, because it must not apply to
  // every order that gets refunded. A cancellation keeps CANCELLED — the more
  // meaningful record of why the order ended, and there is no
  // CANCELLED -> REFUNDED edge in VALID_TRANSITIONS.
  //
  // This guard did not exist before and did not need to: the resolve path
  // marked the request RESOLVED_REFUNDED at acceptance, so this whole block was
  // skipped for every real delivery. Now that the request honestly stays
  // PROCESSING_REFUND until Razorpay confirms, this runs for cancellation
  // refunds too.
  await tx.order.updateMany({
    where: { id: request.orderId, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
    data: { status: 'REFUNDED' },
  });

  // Same split as the admin resolve path: the shop is liable only for what it
  // actually received, never for the platform's base fee.
  const shopShare = await ledgerService.shopShareOfRefund(tx, request.orderId, refund.amount);

  if (shopShare > 0) {
    await ledgerService.createLedgerEntry({
      shopId: request.shopId,
      type: 'REFUND_DEDUCTION',
      amount: shopShare,
      description: `Refund for order ${request.orderId}`,
      counterparty: 'STUDENT',
      createdBy: 'SYSTEM',
      orderId: request.orderId,
      eventId: ledgerService.refundLedgerEventId(request.id, ledgerService.refundAttemptNumber(request)),
      allowDebt: true,
    }, tx, outboxIds);
  }

  if (moved.count === 0) return null;

  const order = await tx.order.findUnique({
    where: { id: request.orderId },
    select: { userId: true },
  });
  if (!order) return null;

  return { studentUserId: order.userId, orderId: request.orderId, shopId: request.shopId };
}

/**
 * Apply a failed refund: reverse the shop's deduction and correct both screens.
 *
 * The student's money never moved, so the shop must not stay charged. A
 * compensating ADJUSTMENT credit reverses the deduction rather than deleting
 * the original entry — the ledger stays append-only, so both the attempt and
 * its reversal remain auditable.
 *
 * ADJUSTMENT is the exact mirror of REFUND_DEDUCTION: same CLEARING bucket,
 * opposite direction. Credits pay down `debtAmount` first, which is what should
 * happen when the refund had pushed the shop negative.
 *
 * The reversal's own `refund:<id>:reversal` eventId makes a second arrival of
 * the same failure — a redelivered webhook, or the poll after the webhook —
 * harmless.
 */
async function applyRefundFailed(
  tx: Prisma.TransactionClient,
  request: {
    id: string;
    orderId: string;
    shopId: string;
    status: RefundRequestStatus;
    attempts: number;
    razorpayRefundId: string | null;
  },
  outboxIds: string[]
): Promise<RefundParty | null> {
  // Guarding on the statuses that imply a deduction was actually made stops a
  // second arrival from crediting the shop twice.
  if (!['RESOLVED_REFUNDED', 'PROCESSING_REFUND'].includes(request.status)) return null;

  // Reverse the entry *this attempt* wrote. A retry writes its own, so a
  // request-wide key would reverse the wrong one once a refund has failed more
  // than once.
  const attempt = ledgerService.refundAttemptNumber(request);

  const deducted = await tx.ledgerEntry.findUnique({
    where: { eventId: ledgerService.refundLedgerEventId(request.id, attempt) },
  });

  if (deducted) {
    await ledgerService.createLedgerEntry({
      shopId: request.shopId,
      type: 'ADJUSTMENT',
      amount: deducted.amount,
      description:
        `Reversal — Razorpay refund failed for order ${request.orderId}` +
        (request.razorpayRefundId ? ` (refund ${request.razorpayRefundId})` : ''),
      counterparty: 'PLATFORM',
      createdBy: 'SYSTEM',
      orderId: request.orderId,
      eventId: ledgerService.refundReversalEventId(request.id, attempt),
    }, tx, outboxIds);
  }

  const moved = await tx.refundRequest.updateMany({
    where: { id: request.id, status: request.status },
    data: {
      status: 'REFUND_FAILED',
      // Cleared so a retry mints a new refund at the gateway.
      //
      // `settleClaimedRefund` skips the Razorpay call entirely when this column
      // is set — it reads a stored id as "a refund is already in flight", which
      // is true for an attempt that crashed before committing and false for one
      // the gateway has definitively failed. Leaving the dead id here made
      // every retry a silent no-op that parked the request back in
      // PROCESSING_REFUND to wait for a webhook that had already arrived.
      //
      // The id itself is not lost: it is written into the reversal entry's
      // description above, which is append-only.
      razorpayRefundId: null,
      // This attempt is over. Incrementing here — and only here — is what makes
      // the next try a genuinely new one to both Razorpay and the ledger, while
      // leaving an attempt that merely lost its transaction on the same number
      // so its refund is adopted rather than duplicated.
      attempts: { increment: 1 },
    },
  });

  // The order was never actually refunded. Returning it to COMPLETED is the
  // least-wrong terminal state: the print was delivered, and only the refund
  // attempt failed. An admin retries from the REFUND_FAILED request.
  await tx.order.updateMany({
    where: { id: request.orderId, status: 'REFUNDED' },
    data: { status: 'COMPLETED' },
  });

  // Stop the order claiming a refund that did not happen.
  //
  // This is a separate statement from the one above because it must run
  // whatever status the order holds — a cancellation refund never made the
  // order REFUNDED, so the guarded update matches nothing and the stale
  // 'processed' would survive. `refundStatus` is what the admin payment badge
  // is derived from and what the student's order card reads, so leaving it
  // meant both screens showed a completed refund while only the ledger
  // reversal knew otherwise.
  await tx.order.updateMany({
    where: { id: request.orderId },
    // Through the shared constant: this was the one value written in capitals,
    // so every consumer had to know that this single state spelled itself
    // differently from the other two.
    data: {
      refundStatus: ledgerService.ORDER_REFUND_STATUS.failed,
      refundError: 'Refund failed at the gateway',
    },
  });

  if (moved.count === 0) return null;

  const order = await tx.order.findUnique({
    where: { id: request.orderId },
    select: { userId: true },
  });
  if (!order) return null;

  return { studentUserId: order.userId, orderId: request.orderId, shopId: request.shopId };
}

async function processWebhookEvent(eventType: string, event: any, eventId: string) {
  switch (eventType) {
    case 'payment.captured': {
      const payment = event.payload.payment.entity;
      const rpOrderId = payment.order_id;
      const rpPaymentId = payment.id;

      // A Student Pass payment has no local order to match — the buyer is
      // identified by the notes set at creation. This is the path that saves a
      // student who closed the browser before the verify call ran: they are
      // charged either way, so the pass must not depend on the tab staying open.
      if (payment.notes?.subscription_type === 'student_pass' && payment.notes?.userId) {
        // Resolved against the purchase row this payment belongs to, which is
        // what makes the amount check honest (it compares against what the
        // student was quoted, not against today's price) and what stops a
        // second capture overwriting the first beyond recovery.
        const purchase = await findPassPurchase(payment);

        if (purchase) {
          await applyPassCapture(purchase.id, rpPaymentId, payment.amount, payment.notes.userId);
        } else {
          // No purchase row: a checkout minted before the table existed, whose
          // payment landed after the deploy. Honoured as it was sold, and
          // alerted — see `applyLegacyPassCapture`.
          await applyLegacyPassCapture(payment.notes.userId, rpPaymentId, payment.amount);
        }

        await prisma.webhookEvent.update({
          where: { eventId },
          data: { processed: true, processedAt: new Date() },
        });
        break;
      }

      let paidOrderId: string | null = null;
      let mismatchedOrderId: string | null = null;
      let mismatchReason = '';

      await prisma.$transaction(async (tx) => {
        const order = await tx.order.findFirst({
          where: { razorpayOrderId: rpOrderId },
        });

        // What was actually paid must equal what this order costs, read from our
        // own row rather than from the webhook.
        //
        // A valid HMAC proves the payload came from Razorpay; it says nothing
        // about the sum being the one this order should cost. Today Razorpay
        // enforces the amount attached to the order it issued, so a short
        // payment cannot arrive — but that is Razorpay's invariant, not ours,
        // and it stops holding the moment partial payments are enabled on the
        // account. Fulfilling on someone else's guarantee is what leaves an
        // order marked paid for less than it cost.
        const amountMatches = order ? payment.amount === order.totalPrice : false;

        // And that the files are still the ones that amount was computed from.
        //
        // The amount check above compares the payment to `order.totalPrice`,
        // and `totalPrice` is frozen when the Razorpay order is minted — so it
        // agrees with itself no matter what happened to the files afterwards.
        // Swapping a one-page document for a two-hundred-page one leaves both
        // figures untouched and sails straight through it.
        const filesMatch = order
          ? await orderService.pricedFilesUnchanged(tx, order)
          : false;

        // In 'log' mode the comparison still runs and a mismatch is still
        // reported — only the refusal is withheld. Nothing about what gets
        // detected changes when the flag flips, which is what makes watching
        // 'log' a valid rehearsal for 'enforce' rather than a different test.
        const enforceFingerprint = env.FINGERPRINT_VERIFY === 'enforce';
        const filesBlockFulfilment = !filesMatch && enforceFingerprint;

        if (order && !amountMatches) {
          // Money moved and we are declining to fulfil against it, so somebody
          // has to be told. A console line in a log nobody reads is how a
          // student ends up out of pocket with the order still showing unpaid.
          mismatchedOrderId = order.id;
          mismatchReason =
            `captured ${payment.amount} paise but the order costs ${order.totalPrice} ` +
            `(payment ${rpPaymentId})`;
        } else if (order && !filesMatch) {
          // Recorded either way — the whole point of 'log' mode is that the
          // evidence is identical and only the consequence differs, so what is
          // seen in the logs before enforcing is exactly what enforcing acts on.
          mismatchedOrderId = order.id;
          mismatchReason =
            `the files changed after the price was set — paid ${payment.amount} paise for a ` +
            `different file set than the order now holds (payment ${rpPaymentId})` +
            (enforceFingerprint ? '' : ' [FINGERPRINT_VERIFY=log — fulfilled anyway]');
        }

        // Only process if the order exists, has not been paid already, and the
        // sum agrees.
        //
        // PAYMENT_FAILED is accepted as well as PENDING_PAYMENT: the client
        // writes that status when the checkout sheet closes, which routinely
        // happens before a UPI collect is approved. Razorpay is the authority on
        // whether money moved, and it is telling us here that it did — refusing
        // on the strength of our own guess is how a captured payment ended up
        // attached to a dead order.
        const claimable = order?.status === 'PENDING_PAYMENT' || order?.status === 'PAYMENT_FAILED';

        if (order && claimable && amountMatches && !filesBlockFulfilment) {
          // Guarded on the status rather than a bare update: the signature path
          // may have committed the same transition between the read above and
          // this write, and only the caller whose update actually lands may
          // announce the order to the shop.
          const applied = await tx.order.updateMany({
            where: { id: order.id, status: order.status },
            data: {
              status: 'PENDING_APPROVAL',
              razorpayPaymentId: rpPaymentId,
              paymentVerifiedVia: 'webhook',
            },
          });
          if (applied.count === 1) paidOrderId = order.id;
        }

        // Mark webhook as processed (inside the same transaction)
        await tx.webhookEvent.update({
          where: { eventId },
          data: { processed: true, processedAt: new Date() },
        });
      });

      // After commit — an announcement about a transaction that later rolled
      // back would tell a shop to print an order that was never paid for. The
      // same applies to the review flag, which writes to the order row and
      // would otherwise be raising an alarm about work that never happened.
      if (paidOrderId) await announcePaidOrder(paidOrderId);
      if (mismatchedOrderId) await flagForReview(mismatchedOrderId, mismatchReason);
      break;
    }

    case 'payment.failed': {
      const payment = event.payload.payment.entity;
      const rpOrderId = payment.order_id;

      await prisma.$transaction(async (tx) => {
        const order = await tx.order.findFirst({
          where: { razorpayOrderId: rpOrderId },
        });

        if (order && order.status === 'PENDING_PAYMENT') {
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: 'PAYMENT_FAILED',
              paymentVerifiedVia: 'webhook_failed',
            },
          });
        }

        await tx.webhookEvent.update({
          where: { eventId },
          data: { processed: true, processedAt: new Date() },
        });
      });
      break;
    }

    /**
     * Razorpay confirms the refund actually settled.
     *
     * This is the event that ends a refund. `settleClaimedRefund` leaves the
     * request in PROCESSING_REFUND because Razorpay's acceptance is not
     * settlement, so nothing tells the student their money arrived until this
     * arrives — or until `reconcileStuckRefunds` goes and asks.
     *
     * The effects live in `applyRefundProcessed`, shared with that poll.
     */
    case 'refund.processed': {
      const refund = event.payload.refund.entity;
      const outboxIds: string[] = [];

      // Only the delivery that actually moved the row may tell the student —
      // `applyRefundProcessed` returns null for every other caller.
      const confirmedHere = await prisma.$transaction(async (tx) => {
        const request = await findRefundRequest(tx, refund);
        const party = request
          ? await applyRefundProcessed(tx, request, refund, outboxIds)
          : null;

        await tx.webhookEvent.update({
          where: { eventId },
          data: { processed: true, processedAt: new Date() },
        });

        return party;
      });

      await realtimeService.publishQueued(outboxIds);

      // After commit. The student was last told the refund was on its way;
      // this is the message that closes that loop.
      if (confirmedHere) {
        notify.notifyRefundSettled({
          ...confirmedHere,
          amountPaise: refund.amount,
          throughGateway: true,
        });
      }
      break;
    }

    /**
     * Razorpay failed the refund after accepting it.
     *
     * The effects live in `applyRefundFailed`, shared with the reconciliation
     * poll — which is the only thing that notices a failure at all when this
     * event is not configured on the webhook.
     */
    case 'refund.failed': {
      const refund = event.payload.refund.entity;
      const outboxIds: string[] = [];

      const failedHere = await prisma.$transaction(async (tx) => {
        const request = await findRefundRequest(tx, refund);
        const party = request ? await applyRefundFailed(tx, request, outboxIds) : null;

        await tx.webhookEvent.update({
          where: { eventId },
          data: { processed: true, processedAt: new Date() },
        });

        return party;
      });

      await realtimeService.publishQueued(outboxIds);

      // After commit. The student's last message said their money was on the
      // way; without this that stays the final word and they wait out the
      // 5-7 days for money that is never coming. Also pages the admins, since
      // the retry needs a human.
      if (failedHere) {
        notify.notifyRefundFailed({
          ...failedHere,
          amountPaise: refund.amount,
        });
      }
      break;
    }

    default: {
      // Unknown event type — mark as processed so we don't retry it
      await prisma.webhookEvent.update({
        where: { eventId },
        data: { processed: true, processedAt: new Date() },
      });
      break;
    }
  }
}

// ────────────────────────────────────────────────────────────
// RECONCILIATION — Upgrade B: The safety net
// ────────────────────────────────────────────────────────────

/**
 * Reconcile stuck payments by polling Razorpay's API.
 *
 * This is the PULL mechanism. Webhooks are the PUSH mechanism.
 * Together they ensure no payment is ever lost.
 *
 * Scans for orders stuck in PENDING_PAYMENT with a razorpayOrderId
 * older than `thresholdMinutes`. For each, queries Razorpay's Orders
 * API for the ground truth. If Razorpay says "paid", we fulfill it.
 *
 * Called by: a cron service hitting POST /api/v1/payments/reconcile
 */
/**
 * Cancel orders that were uploaded and never paid for, and let retention take
 * their documents.
 *
 * Lives here rather than in `order.service` for two reasons: the question this
 * job asks is "did this payment ever actually happen", which is payment
 * reconciliation; and it needs `adoptCapturedPayment`, which is module-private
 * here. `order.service` importing this file would also be a cycle — this one
 * already imports that one.
 *
 * Cancelling rather than deleting the files directly is deliberate. CANCELLED
 * is already a terminal status, so `updateOrderStatus` runs the existing
 * retention path and there is no second definition anywhere of when bytes may
 * go. Nulling `fileStoragePath` while leaving the order payable would produce
 * an order that can still be paid for and has nothing to print.
 *
 * Why this exists at all: both the inline purge and the retention sweep are
 * gated on a terminal status, so an order that never reaches one keeps its
 * document forever. Most of that population is exactly this — uploaded, never
 * paid, walked away. The app also told students their draft "will expire
 * automatically", which was not true of anything until this ran.
 */
export async function expireStaleUnpaidOrders(
  now: Date = new Date()
): Promise<{ examined: number; cancelled: number; stillPaid: number; skipped: number }> {
  const cutoff = new Date(now.getTime() - env.UNPAID_ORDER_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const stale = await prisma.order.findMany({
    where: {
      status: { in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] },
      uploadedAt: { lt: cutoff },
    },
    select: { id: true, status: true, razorpayOrderId: true, totalPrice: true },
    // Bounded like every other sweep: a backlog is worked through over
    // successive runs rather than in one transaction-hogging pass.
    take: 100,
  });

  const result = { examined: stale.length, cancelled: 0, stillPaid: 0, skipped: 0 };

  for (const order of stale) {
    /**
     * Ask the gateway before cancelling anything that ever reached checkout.
     *
     * A Razorpay order outlives our idea of the payment: the sheet can be
     * completed days later, and a capture whose webhook was lost looks exactly
     * like an abandoned draft from here. Cancelling one of those destroys the
     * document for an order somebody actually paid for.
     *
     * Deliberately not relying on `reconcilePayments` having already adopted
     * it. It almost certainly has, well inside three days — and that reasoning
     * is precisely what would keep this check missing until the once-a-year
     * case where it had not.
     */
    if (order.razorpayOrderId) {
      let recovery: RecoveryOutcome;
      try {
        recovery = await adoptCapturedPayment({
          id: order.id,
          status: order.status,
          razorpayOrderId: order.razorpayOrderId,
          totalPrice: order.totalPrice,
        });
      } catch (error) {
        // Fail closed. Not knowing whether money moved is not the same as
        // knowing it did not, and the cost of guessing wrong here is a paid
        // student's file deleted. Leave it for the next run.
        console.error(`[expire-unpaid] gateway check failed for ${order.id}, leaving it:`, error);
        result.skipped += 1;
        continue;
      }

      if (recovery.outcome !== 'unpaid') {
        // recovered / claimed_elsewhere: it was paid after all, and
        // adoptCapturedPayment has just moved it on. needs_review: a human has
        // to look, and it has already been flagged.
        result.stillPaid += 1;
        continue;
      }
    }

    try {
      // Through the ordinary transition, so the student is notified, the files
      // are purged, and `claimCancellationRefund` gets its say — it returns
      // null when `razorpayPaymentId` is null, so a genuinely unpaid order has
      // no refund side effect.
      await orderService.updateOrderStatus(order.id, 'CANCELLED', SYSTEM_ACTOR_ID, 'ADMIN');
      result.cancelled += 1;
    } catch (error) {
      // Someone paid or cancelled it between the query and here; the status
      // guard inside `updateOrderStatus` refused. Nothing to do.
      console.error(`[expire-unpaid] could not cancel ${order.id}:`, error);
      result.skipped += 1;
    }
  }

  return result;
}

export async function reconcilePayments(thresholdMinutes: number = 15) {
  const threshold = new Date(Date.now() - thresholdMinutes * 60 * 1000);

  // Orders that reached the gateway but never landed as paid here, more than
  // `thresholdMinutes` ago.
  //
  // PAYMENT_FAILED is included deliberately. That status is written by the
  // client the instant the checkout sheet closes, which is a guess: a student
  // who dismissed the sheet and then approved the UPI collect in their bank app
  // is recorded as failed here and captured at Razorpay. Sweeping only
  // PENDING_PAYMENT left exactly those payments stranded — money taken, order
  // dead, and nothing in the system looking for it.
  const stuckOrders = await prisma.order.findMany({
    where: {
      status: { in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] },
      razorpayOrderId: { not: null },
      paymentAttemptedAt: { lt: threshold },
    },
    select: {
      id: true,
      status: true,
      razorpayOrderId: true,
      totalPrice: true,
    },
    // Bounded like the expiry sweep and the webhook retry below, which this sat
    // between while being the only one of the three that was not.
    //
    // The working set is not the handful of genuinely stuck payments — it is
    // every abandoned checkout, which keeps `razorpayOrderId` and a stale
    // `paymentAttemptedAt` until `expireStaleUnpaidOrders` cancels it three days
    // later. Each one costs *two* gateway calls inside `adoptCapturedPayment`,
    // re-spent every fifteen minutes, so a few hundred abandoned carts is tens
    // of thousands of Razorpay calls a day to learn nothing. Worse, a sweep that
    // outruns its own interval halves the reconciliation rate for the real stuck
    // payments, because `schedule`'s overlap guard skips the next tick.
    //
    // Oldest first, so a backlog drains in order rather than starving its tail.
    orderBy: { paymentAttemptedAt: 'asc' },
    take: 100,
  });

  // No early return when there is nothing stuck. There used to be one, and it
  // skipped the unprocessed-webhook retry below with it — so a webhook that
  // died mid-processing was only ever retried on a sweep that happened to also
  // find a stuck order. The two halves of this job are independent, and the
  // webhook half is the one that recovers events nothing else will.
  let reconciled = 0;
  let flagged = 0;

  for (const order of stuckOrders) {
    try {
      // Same helper the retry path uses, so the two cannot come to different
      // conclusions about what counts as a recoverable payment — including the
      // amount check, which is the part that matters. Anything needing a human
      // has already alerted the admins from inside, once.
      const recovery = await adoptCapturedPayment({
        id: order.id,
        status: order.status,
        razorpayOrderId: order.razorpayOrderId!,
        totalPrice: order.totalPrice,
      });

      if (recovery.outcome === 'recovered') reconciled++;
      if (recovery.outcome === 'needs_review') flagged++;
    } catch (error) {
      // Don't let one failed reconciliation kill the whole batch
      console.error(`❌ Reconciliation failed for order ${order.id}:`, error);
    }
  }

  // Also retry any unprocessed webhook events.
  //
  // Bounded on both axes. `attempts` stops an event that can never succeed from
  // being re-attempted by every pass forever — it is escalated to the admins
  // once and then left alone — and `take` stops a backlog from making one sweep
  // run unboundedly long. Neither limit existed, so a single poison payload was
  // retried every fifteen minutes indefinitely, silently.
  const unprocessedEvents = await prisma.webhookEvent.findMany({
    where: {
      processed: false,
      attempts: { lt: MAX_WEBHOOK_ATTEMPTS },
      createdAt: { lt: threshold },
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });

  let retriedWebhooks = 0;

  for (const webhookEvent of unprocessedEvents) {
    // Same claim the live delivery path takes, so a sweep cannot process an
    // event a webhook delivery is working on at this moment.
    if (!(await claimWebhookEvent(webhookEvent.eventId))) continue;

    try {
      const payload = webhookEvent.payload as any;
      await processWebhookEvent(webhookEvent.eventType, payload, webhookEvent.eventId);
      retriedWebhooks++;
      console.log(`🔄 Reprocessed webhook event ${webhookEvent.eventId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await releaseWebhookClaim(webhookEvent.eventId, message);
      console.error(`❌ Failed to reprocess webhook ${webhookEvent.eventId}:`, error);
    }
  }

  return {
    checked: stuckOrders.length,
    reconciled,
    /** Payments that moved money we could not match to an order. Admins alerted. */
    flagged,
    /** Events this pass actually reprocessed — not merely selected. */
    retriedWebhooks,
  };
}

// ────────────────────────────────────────────────────────────
// STUDENT PASS
// ────────────────────────────────────────────────────────────

/**
 * Create a Razorpay order for a Student Pass.
 *
 * Unlike a print order there is no local row to hang this off, so the receipt
 * and notes carry the user id — that is what lets the webhook activate the pass
 * if the student closes the browser before the verify call runs.
 */
export interface PassCheckoutResult {
  razorpayOrderId: string;
  amount: number;
  currency: string;
  key: string;
  /** True when this call found the pass already paid for and applied it. */
  paid?: boolean;
  /** Human-readable, shown when `paid` is true. */
  message?: string;
}

/**
 * Open — or re-open — a Student Pass checkout.
 *
 * Every purchase now has a row, and that row is what makes a second charge
 * impossible rather than unlikely. Three properties do the work, in the order a
 * request meets them:
 *
 *  1. An open checkout is *returned*, not refused. The student who taps twice
 *     gets the same Razorpay order back, so there is only ever one order for
 *     them to pay — which is a better answer than an error and a stronger
 *     guarantee than a lock, because Razorpay itself will not let one order be
 *     paid twice.
 *  2. A stale checkout is asked about at the gateway before anything new is
 *     minted, exactly as `adoptCapturedPayment` does for a print order. A UPI
 *     collect approved after the sheet was dismissed is adopted rather than
 *     charged again.
 *  3. The insert is serialised by a partial unique index on
 *     `userId WHERE status = 'OPEN'`. Two concurrent requests cannot both
 *     create an open checkout; Postgres refuses the second in the index, with
 *     no timer and no compare-and-swap to get wrong.
 */
export async function createStudentPassOrder(userId: string): Promise<PassCheckoutResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { type: true, hasStudentPass: true, studentPassActivatedAt: true },
  });
  if (!user) throw ApiError.notFound('User not found');
  if (user.type !== 'STUDENT') throw ApiError.forbidden('Only students can buy a Student Pass');

  // Refusing rather than stacking: a second pass bought while one is live would
  // silently reset the 30 days and lose the remainder the student paid for.
  if (isStudentPassActive(user.hasStudentPass, user.studentPassActivatedAt)) {
    throw ApiError.badRequest('Your Student Pass is still active.');
  }

  const open = await prisma.studentPassPurchase.findFirst({
    where: { userId, status: 'OPEN' },
  });

  if (open) {
    // ── Still live: hand back the same checkout ──
    //
    // The idempotent hit, and the reason this path is a return rather than the
    // 400 a lock would have to give. One gateway order means one possible
    // capture, so the student tapping "Buy" again is harmless — and being shown
    // the sheet again is what they were asking for.
    if (open.razorpayOrderId && open.expiresAt > new Date()) {
      return {
        razorpayOrderId: open.razorpayOrderId,
        amount: open.amountPaise,
        currency: 'INR',
        key: env.RAZORPAY_KEY_ID,
      };
    }

    // ── Expired, or never got its gateway order ──
    //
    // Ask before replacing it. A Razorpay order outlives our idea of the
    // checkout: the sheet can be dismissed and the collect approved twenty
    // minutes later, and that capture looks exactly like an abandoned checkout
    // from here. Minting a second order without looking is how one payment
    // becomes two, and it is the case a TTL alone could never see.
    if (open.razorpayOrderId) {
      const adopted = await adoptPaidPassCheckout(open.id, open.razorpayOrderId, userId);
      if (adopted) return adopted;
    }

    // Genuinely unpaid. Free the slot; the row stays, so a capture arriving
    // even later still finds the purchase it belongs to.
    await prisma.studentPassPurchase.updateMany({
      where: { id: open.id, status: 'OPEN' },
      data: { status: 'ABANDONED' },
    });
  }

  // ── Claim the one open slot ──
  //
  // The partial unique index is the serialisation. A concurrent request that
  // loses does not retry into a second gateway order — it reads the winner's
  // checkout and returns that, which is the same answer the fast path above
  // gives and the same single order.
  let purchase: { id: string };
  try {
    purchase = await prisma.studentPassPurchase.create({
      data: {
        userId,
        amountPaise: env.STUDENT_PASS_PRICE_PAISE,
        expiresAt: new Date(Date.now() + PASS_CHECKOUT_EXPIRY_MS),
      },
      select: { id: true },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const winner = await prisma.studentPassPurchase.findFirst({
      where: { userId, status: 'OPEN', razorpayOrderId: { not: null } },
    });
    if (winner?.razorpayOrderId) {
      return {
        razorpayOrderId: winner.razorpayOrderId,
        amount: winner.amountPaise,
        currency: 'INR',
        key: env.RAZORPAY_KEY_ID,
      };
    }
    // The winner has the slot but has not heard back from Razorpay yet. A
    // moment, not a failure.
    throw ApiError.conflict(
      'Your Student Pass checkout is being set up. Please try again in a moment.'
    );
  }

  /** Give the slot back, so a refusal never leaves the student unable to buy. */
  const abandon = async () => {
    await prisma.studentPassPurchase
      .updateMany({ where: { id: purchase.id, status: 'OPEN' }, data: { status: 'ABANDONED' } })
      .catch((error) =>
        console.error(`[payment] could not abandon pass checkout ${purchase.id}:`, error)
      );
  };

  let rpOrder: { id: string };
  try {
    const razorpay = getRazorpay();
    rpOrder = await razorpay.orders.create({
      amount: env.STUDENT_PASS_PRICE_PAISE,
      currency: 'INR',
      // The purchase id, so the gateway order and the row name each other. The
      // receipt used to carry a timestamp for uniqueness; a cuid is unique by
      // construction and is something we can look up.
      receipt: `pass_${purchase.id}`,
      notes: {
        userId,
        purchaseId: purchase.id,
        subscription_type: 'student_pass',
      },
    });

    await prisma.studentPassPurchase.update({
      where: { id: purchase.id },
      data: { razorpayOrderId: rpOrder.id },
    });
  } catch (error) {
    await abandon();
    throw error;
  }

  return {
    razorpayOrderId: rpOrder.id,
    amount: env.STUDENT_PASS_PRICE_PAISE,
    currency: 'INR',
    key: env.RAZORPAY_KEY_ID,
  };
}

/** Prisma's unique-constraint violation, without importing its error classes. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

/**
 * Adopt a pass checkout Razorpay turns out to have been paid.
 *
 * The mirror of `adoptCapturedPayment` on the order path, and it exists for the
 * same reason: the money is gone from the student's account either way, so the
 * only question is whether we notice. Returning a result means "do not mint
 * anything new"; returning null means the gateway agrees nobody paid.
 *
 * A gateway lookup that fails returns null deliberately — see the call site.
 */
async function adoptPaidPassCheckout(
  purchaseId: string,
  razorpayOrderId: string,
  userId: string
): Promise<PassCheckoutResult | null> {
  let captured: { id: string; amount: number } | null = null;

  try {
    const razorpay = getRazorpay();
    const rpOrder = await razorpay.orders.fetch(razorpayOrderId);
    if (rpOrder.status !== 'paid') return null;

    const payments = await razorpay.orders.fetchPayments(razorpayOrderId);
    const hit = (payments as { items?: Array<{ id: string; status: string; amount: number }> })
      .items?.find((p) => p.status === 'captured');
    captured = hit ? { id: hit.id, amount: hit.amount } : null;
  } catch (error) {
    // Fail *open* here, unlike the order path, and the difference is deliberate.
    // There the cost of guessing wrong is a paid student's file deleted; here it
    // is a second gateway order, which the capture path then reconciles against
    // its own purchase row and stacks. Blocking a student from buying a pass
    // because Razorpay is briefly unreachable is the worse trade.
    console.error(`[payment] could not check pass checkout ${razorpayOrderId} before replacing it:`, error);
    return null;
  }

  if (!captured) {
    // Razorpay says paid but lists no capture. Money is somewhere in that gap,
    // so this is not a green light to charge again.
    await prisma.studentPassPurchase.updateMany({
      where: { id: purchaseId, status: 'OPEN' },
      data: { status: 'REFUSED', refusedReason: 'gateway reports the order paid but lists no capture' },
    });
    notify.notifyAdmins(
      `Student Pass order ${razorpayOrderId} (user ${userId}) is paid at Razorpay but lists no ` +
      `captured payment. The pass was not activated and this needs a human.`,
      'error'
    );
    throw ApiError.conflict(
      'We have found a payment against your Student Pass but cannot match it yet. ' +
      'Our team has been alerted — please do not pay again.'
    );
  }

  const outcome = await applyPassCapture(purchaseId, captured.id, captured.amount, userId);

  if (!outcome.applied) {
    throw ApiError.conflict(
      'We have found a payment against your Student Pass but the amount does not match. ' +
      'Our team has been alerted — please do not pay again.'
    );
  }

  return {
    razorpayOrderId,
    amount: captured.amount,
    currency: 'INR',
    key: env.RAZORPAY_KEY_ID,
    paid: true,
    message: 'Your earlier payment did go through — your Student Pass is active.',
  };
}

export interface PassCaptureOutcome {
  /** True when the pass was actually applied. False means the money was refused. */
  applied: boolean;
  /** Present when applied; carries whether the window was stacked. */
  activation?: PassActivation;
}

/**
 * Resolve one captured pass payment against the purchase it belongs to.
 *
 * The single place a pass capture is applied, reached from all three directions
 * — the webhook, the client's verify call, and the adoption check when a stale
 * checkout is replaced. Three copies of "the money landed, apply the pass" is
 * how they come to disagree about what a paid pass looks like.
 *
 * Idempotent through the purchase's own status: only an OPEN or ABANDONED
 * purchase can be paid, so a redelivered webhook, or the verify call racing it,
 * matches nothing and applies nothing.
 *
 * ABANDONED is accepted deliberately. A checkout that expired unpaid still has
 * its row, and a UPI collect approved half an hour later is a real payment for
 * a real purchase — refusing it because we had given up waiting would take the
 * student's money and deliver nothing.
 */
export async function applyPassCapture(
  purchaseId: string,
  paymentId: string,
  amountPaise: number,
  userId: string
): Promise<PassCaptureOutcome> {
  const purchase = await prisma.studentPassPurchase.findUnique({ where: { id: purchaseId } });

  if (!purchase) {
    // A capture whose purchase does not exist. The audit is what finds these;
    // this is only the path that refuses to guess.
    console.error(`⚠️ Student Pass payment ${paymentId} names purchase ${purchaseId}, which does not exist.`);
    notify.notifyAdmins(
      `A captured Student Pass payment (${paymentId}, user ${userId}) refers to a purchase ` +
      `that does not exist. The pass was not activated — this needs a human.`,
      'error'
    );
    return { applied: false };
  }

  if (purchase.status === 'PAID' || purchase.status === 'REFUSED') {
    // Already resolved by whichever path arrived first.
    return { applied: purchase.status === 'PAID' };
  }

  // Judged against what the student was quoted when this checkout was minted,
  // not against the current price. A price change while a checkout is open is
  // an ordinary thing to do and must not turn a good payment into a refused
  // one — which is exactly what comparing against `env` would have done.
  if (amountPaise !== purchase.amountPaise) {
    const reason =
      `captured ${amountPaise} paise but this checkout was quoted ${purchase.amountPaise}`;

    console.error(`⚠️ Student Pass payment ${paymentId} refused — ${reason}.`);

    await prisma.studentPassPurchase.updateMany({
      where: { id: purchase.id, status: { in: ['OPEN', 'ABANDONED'] } },
      data: { status: 'REFUSED', razorpayPaymentId: paymentId, refusedReason: reason },
    });

    // Money moved and nothing is being delivered, so somebody has to be told.
    // The purchase row is what makes this recoverable: it names the payment, the
    // student and the sum, which is everything a refund needs.
    notify.notifyAdmins(
      `A Student Pass payment was refused — ${reason} (payment ${paymentId}, user ${userId}, ` +
      `purchase ${purchase.id}). The pass was NOT activated and the money has not been returned.`,
      'error'
    );

    return { applied: false };
  }

  const activation = await prisma.$transaction(async (tx) => {
    const claimed = await tx.studentPassPurchase.updateMany({
      where: { id: purchase.id, status: { in: ['OPEN', 'ABANDONED'] } },
      data: { status: 'PAID', razorpayPaymentId: paymentId },
    });

    // Another delivery got here first. Its transaction applied the pass; this
    // one must not apply it again.
    if (claimed.count === 0) return null;

    const result = await activateStudentPass(userId, paymentId, tx);

    await tx.studentPassPurchase.update({
      where: { id: purchase.id },
      data: { appliedFrom: result.activatedAt },
    });

    return result;
  });

  if (!activation) return { applied: true };

  reportStackedPass(activation, userId, paymentId);
  return { applied: true, activation };
}

/**
 * Apply a pass capture that has no purchase row, the way the old code did.
 *
 * Only one population can reach this: a checkout minted before
 * `student_pass_purchases` existed, whose payment lands after the deploy. Its
 * notes carry no `purchaseId` and its gateway order is in no row, so
 * `findPassPurchase` cannot match it — and refusing on that basis would charge
 * a student ₹49 and give them nothing, for the crime of being mid-checkout
 * while we shipped.
 *
 * So it keeps the behaviour it was minted under, including comparing against
 * `STUDENT_PASS_PRICE_PAISE` — which was the correct quote for those checkouts,
 * because it is the figure they were opened at.
 *
 * Alerted either way. This population drains within one checkout window and
 * should then never appear again; a payment arriving here a week after the
 * deploy is not a legacy checkout, it is something worth looking at.
 */
export async function applyLegacyPassCapture(
  userId: string,
  paymentId: string,
  amountPaise: number
): Promise<PassCaptureOutcome> {
  if (amountPaise !== env.STUDENT_PASS_PRICE_PAISE) {
    console.error(
      `⚠️ Student Pass payment ${paymentId} has no purchase row and is for ${amountPaise} paise, ` +
      `not ${env.STUDENT_PASS_PRICE_PAISE} — not activating.`
    );
    notify.notifyAdmins(
      `A Student Pass payment (${paymentId}, user ${userId}) has no purchase record and does not ` +
      `match the price. The pass was NOT activated and the money has not been returned.`,
      'error'
    );
    return { applied: false };
  }

  console.warn(
    `[payment] Student Pass payment ${paymentId} has no purchase row — treating it as a checkout ` +
    `minted before the table existed.`
  );
  notify.notifyAdmins(
    `A Student Pass payment (${paymentId}, user ${userId}) arrived with no purchase record. It has ` +
    `been honoured as a checkout opened before purchases were recorded. If this appears well after ` +
    `that deploy, it needs a look.`,
    'warning'
  );

  const activation = await activateStudentPass(userId, paymentId);
  reportStackedPass(activation, userId, paymentId);

  return { applied: true, activation };
}

/**
 * Find the purchase a captured pass payment belongs to.
 *
 * `notes.purchaseId` is set on every checkout this code mints, so the match is
 * exact. The gateway order id is the fallback, which covers a payment made
 * against a checkout minted before notes carried the id.
 */
async function findPassPurchase(payment: {
  order_id?: string | null;
  notes?: Record<string, string | undefined> | null;
}): Promise<{ id: string } | null> {
  const claimed = payment.notes?.purchaseId;
  if (claimed) {
    const byId = await prisma.studentPassPurchase.findUnique({
      where: { id: claimed },
      select: { id: true },
    });
    if (byId) return byId;
  }

  if (!payment.order_id) return null;

  return prisma.studentPassPurchase.findUnique({
    where: { razorpayOrderId: payment.order_id },
    select: { id: true },
  });
}

/**
 * Tell the admins when a student has paid for a pass they already hold.
 *
 * `activateStudentPass` now grants the extra days rather than losing them, so
 * nothing is broken by the time this runs — but the student has been charged
 * twice for something they only meant to buy once, and that is a refund
 * decision a person has to make. Nothing else can surface it: a pass has no
 * order row, and `auditCapturedPayments` skips pass payments by design.
 */
function reportStackedPass(activation: PassActivation, userId: string, paymentId: string): void {
  if (!activation.stacked) return;

  console.warn(
    `⚠️ Student Pass payment ${paymentId} arrived for user ${userId} who already held a live pass — ` +
    `extended instead of reset.`
  );
  notify.notifyAdmins(
    `Student ${userId} paid for a Student Pass while one was still active (payment ${paymentId}). ` +
    `Their pass has been extended rather than reset, so no days were lost — but they have been ` +
    `charged twice and may be owed a refund.`,
    'warning'
  );
}

export interface PassActivation {
  /** True when this call was the one that applied the pass. */
  activated: boolean;
  /**
   * True when a pass that was *still live* got extended — i.e. this is a second
   * payment for a pass the student already holds. Worth a human's attention:
   * they have been charged twice, and the platform now owes them either the
   * extra days (which this grants) or a refund.
   */
  stacked: boolean;
  /** The start of the 30-day window now in force. */
  activatedAt: Date | null;
}

/**
 * Turn a paid pass payment into an active pass.
 *
 * Idempotent through `studentPassPaymentId`: re-running with the same payment
 * id changes nothing, so a verify call racing the webhook cannot grant two
 * passes or move the expiry forward twice. A *different* payment id is allowed
 * through, which is what makes renewal work.
 *
 * A different payment id used to overwrite `studentPassActivatedAt` with the
 * current time, and that lost days the student had paid for. Nothing dedupes
 * two open pass checkouts — a pass has no local row to claim, unlike a print
 * order — so a dismissed sheet followed by a second attempt, with the first
 * UPI collect approved later, produced two captures. The second reset the
 * window: ₹98 charged, thirty days delivered, and no record of the first
 * payment left anywhere, because `studentPassPaymentId` had just been
 * overwritten and `auditCapturedPayments` skips pass payments by design.
 *
 * So a second payment now *stacks*: the new window begins where the live one
 * ends, and the student gets the sixty days they paid for. The read and the
 * write share a transaction, so two captures arriving together cannot both read
 * the same expiry and both extend from it.
 */
export async function activateStudentPass(
  userId: string,
  paymentId: string,
  /**
   * Join the caller's transaction.
   *
   * `applyPassCapture` passes its own, so marking the purchase paid and
   * applying the pass commit together — a purchase recorded as PAID against a
   * student whose pass never moved would be the worst of both records.
   */
  txClient?: Prisma.TransactionClient
): Promise<PassActivation> {
  const execute = async (tx: Prisma.TransactionClient): Promise<PassActivation> => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { hasStudentPass: true, studentPassActivatedAt: true, studentPassPaymentId: true },
    });

    if (!user) return { activated: false, stacked: false, activatedAt: null };

    // Already applied by whichever of verify/webhook got here first.
    if (user.studentPassPaymentId === paymentId) {
      return { activated: false, stacked: false, activatedAt: user.studentPassActivatedAt };
    }

    const stillActive = isStudentPassActive(user.hasStudentPass, user.studentPassActivatedAt);

    // Extend from the moment the live window ends, not from now. `activatedAt`
    // is the *start* of the window in force, so a future value is correct and
    // `isStudentPassActive` — `now < activatedAt + PASS_DURATION_MS` — keeps
    // returning true throughout the gap.
    const activatedAt = stillActive && user.studentPassActivatedAt
      ? new Date(user.studentPassActivatedAt.getTime() + PASS_DURATION_MS)
      : new Date();

    const applied = await tx.user.updateMany({
      where: {
        id: userId,
        // The null branch is required, not defensive. `{ not: x }` compiles to a
        // SQL inequality, and NULL <> 'x' is NULL rather than true, so a column
        // that has never been set matches nothing — which is every first-time
        // buyer. Without this the guard silently excluded exactly the case it was
        // meant to allow, and a paid pass never activated.
        OR: [
          { studentPassPaymentId: null },
          { studentPassPaymentId: { not: paymentId } },
        ],
      },
      data: {
        hasStudentPass: true,
        studentPassActivatedAt: activatedAt,
        studentPassPaymentId: paymentId,
      },
    });

    return {
      activated: applied.count > 0,
      stacked: stillActive && applied.count > 0,
      activatedAt,
    };
  };

  return txClient ? execute(txClient) : prisma.$transaction(execute);
}

/**
 * Verify a Student Pass payment and activate the pass.
 *
 * The signature is checked against Razorpay's HMAC before anything is written,
 * so a forged callback cannot grant a free pass.
 */
export async function verifyStudentPassPayment(
  userId: string,
  razorpayOrderId: string,
  razorpayPaymentId: string,
  razorpaySignature: string
) {
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (!signaturesMatch(expected, razorpaySignature)) {
    throw ApiError.unauthorized('Invalid payment signature');
  }

  // Confirm with Razorpay that this order really belongs to this user and was
  // actually paid. The signature proves the payload is authentic, not that the
  // payer is who the request claims to be.
  const razorpay = getRazorpay();
  const rpOrder = await razorpay.orders.fetch(razorpayOrderId) as any;

  if (rpOrder?.notes?.userId !== userId || rpOrder?.notes?.subscription_type !== 'student_pass') {
    throw ApiError.forbidden('This payment does not belong to your Student Pass.');
  }

  // The same check the webhook branch makes, and for the same reason: a valid
  // signature proves Razorpay sent this, not that the money moved or that the
  // right sum moved. Razorpay enforces the order's amount today, so a short
  // payment cannot reach here — but that is Razorpay's invariant rather than
  // ours, and it stops holding the moment partial payments are enabled on the
  // account. This path granted a pass on the signature alone while the webhook
  // path refused on a mismatch; two answers to one question.
  //
  // Read from the payment rather than from the order's `status`. The order flips
  // to 'paid' asynchronously after capture, and this runs the instant the
  // client's checkout returns — so gating on the order status would
  // intermittently refuse passes that were genuinely paid for. The payment
  // entity is already captured by then, and it is what carries the sum.
  // Typed through the same narrow `RazorpayPayment` the audit uses rather than
  // `any`, so a change to any field we depend on is a compile error here rather
  // than an `undefined` that quietly waves a payment through.
  const rpPayment = await razorpay.payments.fetch(razorpayPaymentId) as unknown as RazorpayPayment;

  if (rpPayment?.order_id !== razorpayOrderId) {
    throw ApiError.forbidden('This payment does not belong to that order.');
  }

  if (rpPayment?.status !== 'captured') {
    throw ApiError.badRequest('This Student Pass payment has not completed yet.');
  }

  // Through the same path the webhook uses, so the two cannot come to different
  // conclusions about what a paid pass looks like. It owns the amount check as
  // well — judged against what this checkout was quoted rather than against the
  // current price, so a price change mid-checkout does not refuse a good
  // payment — and it owns marking the purchase resolved either way.
  const purchase = await findPassPurchase({
    order_id: razorpayOrderId,
    notes: rpOrder?.notes as Record<string, string | undefined> | null,
  });

  // A checkout minted before purchases were recorded has no row to match, and
  // refusing it would fail the verify call for a student who has already paid.
  const outcome = purchase
    ? await applyPassCapture(purchase.id, razorpayPaymentId, rpPayment.amount ?? 0, userId)
    : await applyLegacyPassCapture(userId, razorpayPaymentId, rpPayment.amount ?? 0);

  if (!outcome.applied) {
    throw ApiError.badRequest(
      'The amount paid does not match what this Student Pass checkout was for. ' +
      'Our team has been alerted — please do not pay again.'
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { hasStudentPass: true, studentPassActivatedAt: true },
  });

  return {
    hasStudentPass: user?.hasStudentPass ?? false,
    studentPassActivatedAt: user?.studentPassActivatedAt ?? null,
  };
}

// ────────────────────────────────────────────────────────────
// AUDIT — Razorpay as the source of truth
// ────────────────────────────────────────────────────────────

/** A captured payment with no order behind it. */
export interface OrphanPayment {
  paymentId: string;
  amountPaise: number;
  capturedAt: Date;
  /** Our order id, as recorded in the payment's notes when it was created. */
  claimedOrderId: string | null;
  razorpayOrderId: string | null;
  email: string | null;
  contact: string | null;
}

export interface PaymentAuditResult {
  windowStart: Date;
  /** Captured payments old enough to be judged. */
  checked: number;
  /** Captured but too recent to judge yet; see `graceMinutes`. */
  skippedTooRecent: number;
  orphans: OrphanPayment[];
  /**
   * True when the page cap was reached, so the window holds payments this pass
   * never looked at. An empty `orphans` does not mean "nothing is wrong" when
   * this is set — it means "nothing is wrong in the part we could see".
   */
  truncated: boolean;
}

/** Razorpay caps a page at 100. */
const AUDIT_PAGE_SIZE = 100;

/** Pages one audit pass will walk before it reports the window as truncated. */
const AUDIT_MAX_PAGES = 10;

/**
 * The part of a Razorpay payment this audit reads.
 *
 * Narrow on purpose: the SDK's own types are loose, and naming only the fields
 * we depend on means a change to any of them is a compile error here rather
 * than an `undefined` that quietly makes every payment look accounted for.
 */
interface RazorpayPayment {
  id: string;
  status?: string;
  amount?: number;
  order_id?: string | null;
  created_at?: number;
  email?: string | null;
  contact?: string | null;
  notes?: Record<string, string | undefined> | null;
}

/**
 * Find captured payments that no order in this database accounts for.
 *
 * `reconcilePayments` walks from our orders out to Razorpay: it asks, of the
 * orders we know are stuck, which ones Razorpay considers paid. That direction
 * cannot see an order that is not in the table at all — and the table is not
 * guaranteed. A restore that rolls the database back past a payment, a failed
 * insert, a row deleted by a cascade: in each case the money is real, Razorpay
 * remembers it, and nothing here is looking.
 *
 * This walks the other way, from Razorpay in. It is the only check that can
 * detect an order that has ceased to exist, because it never consults our data
 * to decide what to look for.
 *
 * It is worth saying why the obvious alternative is not enough: the ledger
 * reconciles against itself perfectly in exactly this scenario. When an order
 * and its earning are removed together the books still balance — they are
 * simply the books of a smaller business. Internal consistency cannot detect a
 * clean amputation. Only an outside record can.
 *
 * `graceMinutes` exists because a payment captured seconds ago may legitimately
 * not be reflected yet; anything inside that window is counted, not judged.
 */
export async function auditCapturedPayments(options?: {
  windowMinutes?: number;
  graceMinutes?: number;
}): Promise<PaymentAuditResult> {
  const windowMinutes = options?.windowMinutes ?? 24 * 60;
  const graceMinutes = options?.graceMinutes ?? 10;

  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);
  const graceCutoff = new Date(Date.now() - graceMinutes * 60 * 1000);

  const razorpay = getRazorpay();

  const captured: RazorpayPayment[] = [];
  let skip = 0;
  let truncated = false;
  // Bounded so a wide window cannot spin: 10 pages is 1000 payments, far more
  // than this platform sees in a day, and the window is the real control.
  //
  // But "far more than we see" is a growth assumption with nothing asserting
  // it, and hitting the cap used to be indistinguishable from finding nothing.
  // Razorpay returns newest first, so the payments dropped are the *oldest* in
  // the window — exactly the ones past the grace period that are ripe to be
  // judged. This is the only check that can see a payment whose order no longer
  // exists, so it silently covering less than it claims is the worst way for it
  // to fail. `truncated` makes the cap visible to the caller.
  for (let page = 0; page < AUDIT_MAX_PAGES; page++) {
    const response = (await razorpay.payments.all({
      from: Math.floor(windowStart.getTime() / 1000),
      count: AUDIT_PAGE_SIZE,
      skip,
    })) as unknown as { items?: RazorpayPayment[] };

    const items: RazorpayPayment[] = response?.items ?? [];
    captured.push(...items.filter((p) => p?.status === 'captured'));

    if (items.length < AUDIT_PAGE_SIZE) break;

    skip += AUDIT_PAGE_SIZE;
    truncated = page === AUDIT_MAX_PAGES - 1;
  }

  let skippedTooRecent = 0;
  const orphans: OrphanPayment[] = [];
  /**
   * When pass purchases started being recorded, read once and only if needed.
   *
   * `undefined` means not looked up yet; `null` means no purchase has ever
   * been recorded, so no pass payment is auditable.
   */
  let passRecordsBegan: Date | null | undefined;

  for (const payment of captured) {
    const capturedAt = new Date((payment.created_at ?? 0) * 1000);
    if (capturedAt > graceCutoff) {
      skippedTooRecent++;
      continue;
    }

    // ── Student Pass payments ──
    //
    // These used to be skipped outright, and the comment said "not orders and
    // have no order row by design" — which was true, and was exactly why a
    // double-charged pass was invisible to the one check that walks from
    // Razorpay inward. They have a row now, so they are audited like anything
    // else.
    if (payment?.notes?.subscription_type === 'student_pass') {
      const purchase = await findPassPurchase(payment);
      if (purchase) continue;

      // No purchase row. Either a genuine orphan, or a pass sold before this
      // table existed — and those are indistinguishable by inspection, so the
      // floor decides. Anything older than the first purchase we ever recorded
      // predates the table and is not something a human can act on.
      if (passRecordsBegan === undefined) {
        const first = await prisma.studentPassPurchase.findFirst({
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        });
        // Null until the first pass is sold after this ships; that reads as "no
        // pass payment is auditable yet", which is correct.
        passRecordsBegan = first?.createdAt ?? null;
      }

      if (!passRecordsBegan || capturedAt < passRecordsBegan) continue;

      orphans.push({
        paymentId: payment.id,
        amountPaise: payment.amount ?? 0,
        capturedAt,
        claimedOrderId: payment?.notes?.purchaseId ?? null,
        razorpayOrderId: payment?.order_id ?? null,
        email: payment.email ?? null,
        contact: payment.contact ?? null,
      });
      continue;
    }

    const claimedOrderId: string | null = payment?.notes?.orderId ?? payment?.notes?.order_id ?? null;
    const razorpayOrderId: string | null = payment?.order_id ?? null;

    // Three ways to find it, because any one of them can be absent: the
    // payment id is only written once we process the capture, and the notes
    // are only as good as what we sent when the order was created.
    const match = await prisma.order.findFirst({
      where: {
        OR: [
          { razorpayPaymentId: payment.id },
          ...(claimedOrderId ? [{ id: claimedOrderId }] : []),
          ...(razorpayOrderId ? [{ razorpayOrderId }] : []),
        ],
      },
      select: { id: true },
    });

    if (match) continue;

    orphans.push({
      paymentId: payment.id,
      amountPaise: payment.amount ?? 0,
      capturedAt,
      claimedOrderId,
      razorpayOrderId,
      email: payment.email ?? null,
      contact: payment.contact ?? null,
    });
  }

  return {
    windowStart,
    checked: captured.length - skippedTooRecent,
    skippedTooRecent,
    orphans,
    truncated,
  };
}

// ────────────────────────────────────────────────────────────
// REFUND RECONCILIATION — the pull side of the refund lifecycle
// ────────────────────────────────────────────────────────────

export interface RefundReconcileResult {
  /** Requests that were stale enough to be asked about. */
  checked: number;
  /** Confirmed settled by the gateway on this pass. */
  confirmed: number;
  /** Confirmed failed by the gateway on this pass. */
  failed: number;
  /** Genuinely still in flight — Razorpay has it and has not finished. */
  stillPending: number;
  /**
   * Requests that claim to be refunding but that the gateway has no refund
   * for. These are the ones a human has to look at: the refund was never
   * actually initiated, so nobody is waiting on Razorpay for anything.
   */
  stranded: string[];
  /** Requests whose gateway lookup threw. Retried on the next pass. */
  errors: number;
}

/** How many stale requests one pass will ask the gateway about. */
const REFUND_RECONCILE_BATCH = 50;

/**
 * Find the gateway's refund for a request, without trusting that we stored it.
 *
 * The stored `razorpayRefundId` is the fast path. The fallback matters because
 * of the exact crash this whole function exists to survive: `callRazorpayRefund`
 * returns, the local transaction fails to commit, and the id is lost while the
 * refund is real and in flight. Listing the payment's refunds finds it anyway.
 *
 * `notes.orderId` is set on every refund we create, so the match is exact
 * rather than positional — a payment can carry more than one refund, and
 * picking "the first" would attribute a partial refund to the wrong request.
 */
async function findGatewayRefund(request: {
  id: string;
  orderId: string;
  razorpayRefundId: string | null;
  order: { razorpayPaymentId: string | null };
}): Promise<{ id: string; amount: number; status: 'pending' | 'processed' | 'failed' } | null> {
  const razorpay = getRazorpay();

  if (request.razorpayRefundId) {
    const refund = await razorpay.refunds.fetch(request.razorpayRefundId);
    return { id: refund.id, amount: refund.amount ?? 0, status: refund.status };
  }

  if (!request.order.razorpayPaymentId) return null;

  const response = await razorpay.payments.fetchMultipleRefund(request.order.razorpayPaymentId);
  const items = response?.items ?? [];
  const match = items.find((r) => r?.notes?.orderId === request.orderId);
  if (!match) return null;

  return { id: match.id, amount: match.amount ?? 0, status: match.status };
}

/**
 * Ask Razorpay how the refunds we are still waiting on actually ended.
 *
 * This is the pull side of the refund lifecycle, and the webhook is the push
 * side — the same pairing `reconcilePayments` already provides for payments.
 * It exists because the push side is configuration rather than code: the
 * `refund.processed` and `refund.failed` events are ticked by hand in the
 * Razorpay dashboard, live mode and test mode are separate objects with
 * separate subscriptions, and `webhook_events` has never held a single row for
 * either one.
 *
 * Without this, an unticked checkbox means every refund sits in
 * PROCESSING_REFUND forever: the student is told their money is on its way and
 * never told it arrived, the shop is never debited, `Order.refundStatus` stays
 * `pending` on both dashboards, and the order's files are pinned by
 * `UNSETTLED_REFUND_STATUSES` and never purged. Nothing errors, and the first
 * report is a support ticket weeks later.
 *
 * Reconciling is also the only way a *failed* refund is ever noticed when the
 * event is not configured. That one costs real money — the shop stays debited
 * for a refund the student never received.
 *
 * `stuckMinutes` is the grace period. Razorpay settles most refunds in minutes
 * but is entitled to take days, so this does not decide anything is wrong; it
 * only decides when it is worth asking. Anything the gateway still calls
 * `pending` is left exactly as it is.
 */
export async function reconcileStuckRefunds(options?: {
  stuckMinutes?: number;
  limit?: number;
}): Promise<RefundReconcileResult> {
  const stuckMinutes = options?.stuckMinutes ?? 30;
  const limit = options?.limit ?? REFUND_RECONCILE_BATCH;
  const cutoff = new Date(Date.now() - stuckMinutes * 60 * 1000);

  // `adminResolvedAt` is stamped when the gateway leg starts, so it is the age
  // of the refund attempt. It is null when the settle path died before
  // committing — the case that most needs reconciling — so those fall back to
  // when the student asked. RefundRequest has no `updatedAt` to lean on.
  const stuck = await prisma.refundRequest.findMany({
    where: {
      status: 'PROCESSING_REFUND',
      OR: [
        { adminResolvedAt: { lt: cutoff } },
        { adminResolvedAt: null, studentRequestedAt: { lt: cutoff } },
      ],
    },
    select: {
      id: true,
      orderId: true,
      shopId: true,
      status: true,
      razorpayRefundId: true,
      order: { select: { razorpayPaymentId: true } },
    },
    orderBy: { studentRequestedAt: 'asc' },
    take: limit,
  });

  const result: RefundReconcileResult = {
    checked: stuck.length,
    confirmed: 0,
    failed: 0,
    stillPending: 0,
    stranded: [],
    errors: 0,
  };

  for (const request of stuck) {
    try {
      const refund = await findGatewayRefund(request);

      if (!refund) {
        // No refund exists at the gateway for a request that says it is
        // refunding. Waiting cannot fix that, and the money is still with us.
        result.stranded.push(request.id);
        continue;
      }

      if (refund.status === 'pending') {
        result.stillPending++;
        continue;
      }

      const outboxIds: string[] = [];

      // Re-read inside the transaction rather than trusting the row from the
      // scan: the gateway call above is a network round trip, and the webhook
      // this poll exists to replace may have arrived during it. The status
      // guards inside the apply functions are what make the loser silent.
      const party = await prisma.$transaction(async (tx) => {
        const current = await tx.refundRequest.findUnique({ where: { id: request.id } });
        if (!current) return null;

        return refund.status === 'processed'
          ? applyRefundProcessed(tx, current, refund, outboxIds)
          : applyRefundFailed(tx, current, outboxIds);
      });

      await realtimeService.publishQueued(outboxIds);

      // Counted on what this pass actually moved, not on what the gateway
      // said. A null party means the webhook landed during the round trip
      // above and did the work — nothing happened here, and the remediation
      // log should not claim otherwise.
      if (!party) continue;

      if (refund.status === 'processed') {
        result.confirmed++;
        notify.notifyRefundSettled({ ...party, amountPaise: refund.amount, throughGateway: true });
      } else {
        result.failed++;
        notify.notifyRefundFailed({ ...party, amountPaise: refund.amount });
      }
    } catch (error) {
      // One unreachable refund must not stop the rest of the batch. The next
      // pass retries it, and the request stays PROCESSING_REFUND meanwhile,
      // which is still the truth.
      result.errors++;
      console.error(`[refund-reconcile] ${request.id} failed:`, error);
    }
  }

  return result;
}

/**
 * Abandon Student Pass checkouts that expired unpaid.
 *
 * Not required for correctness — `createStudentPassOrder` expires a stale
 * checkout lazily when the student comes back, and the partial unique index is
 * what actually guarantees one open checkout at a time. This exists so the
 * table tells the truth for everything that reads it without going through that
 * path: the orphan audit, and anyone looking at why a purchase is still open.
 *
 * The row is kept, only its status changes. A Razorpay order outlives our idea
 * of it, and a capture arriving later still has to find the purchase it belongs
 * to — which is the whole reason this table exists.
 */
export async function abandonExpiredPassCheckouts(now: Date = new Date()): Promise<number> {
  const result = await prisma.studentPassPurchase.updateMany({
    where: { status: 'OPEN', expiresAt: { lt: now } },
    data: { status: 'ABANDONED' },
  });
  return result.count;
}
