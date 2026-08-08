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
import { isStudentPassActive } from './pricing.service';

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
 */
const PAYMENT_CLAIM_TTL_MS = 60 * 1000;

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
    where: { id: orderId, paymentVerifiedVia: { not: 'amount_mismatch' } },
    data: { paymentVerifiedVia: 'amount_mismatch' },
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

  // ── Price the order from pages the server counted, before charging ──
  //
  // `pageCount` reaches the order from the browser and is the multiplier in
  // `pageCount × rate × copies`. Every other pricing input already comes from
  // the database; this is the last one that did not, and understating it
  // understated the bill — a 200-page PDF declared as one page was charged as
  // one page and printed as two hundred.
  //
  // Done before the Razorpay order exists, which is the last moment the price
  // can still move without a student having been charged. If it moves we stop
  // rather than charging the corrected figure: the amount taken must be the
  // amount that was on screen when they agreed to it.
  if (!current.razorpayOrderId && current.status === 'PENDING_PAYMENT') {
    const repriced = await orderService.repriceFromVerifiedPages(orderId);

    if (repriced.unverifiable.length > 0) {
      throw ApiError.badRequest(
        `We could not read the page count for ${repriced.unverifiable.join(', ')}. ` +
        `Please re-upload ${repriced.unverifiable.length > 1 ? 'these files' : 'this file'} before paying.`
      );
    }

    if (repriced.changed) {
      throw ApiError.conflict(
        `The page count for this order was different from what was submitted, so the ` +
        `total is now ₹${(repriced.totalPrice / 100).toFixed(2)} instead of ` +
        `₹${(repriced.previousTotal / 100).toFixed(2)}. Please review and pay again.`
      );
    }
  }

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.userId !== userId) throw ApiError.forbidden('This is not your order');

  // Fast path: a Razorpay order already exists, so hand back the same one.
  if (order.razorpayOrderId && order.status === 'PENDING_PAYMENT') {
    return {
      razorpayOrderId: order.razorpayOrderId,
      amount: order.totalPrice,
      currency: 'INR',
      orderId,
      key: env.RAZORPAY_KEY_ID,
    };
  }

  if (order.status !== 'PENDING_PAYMENT') {
    throw ApiError.badRequest(`Order is in ${order.status} status, not PENDING_PAYMENT`);
  }

  if (order.totalPrice < 100) {
    throw ApiError.badRequest('Minimum order amount is ₹1');
  }

  // ── Claim the right to create, atomically, BEFORE calling Razorpay ──
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
    throw ApiError.conflict('A payment is already being set up for this order. Please try again in a moment.');
  }

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
    // Release the claim so the student can retry immediately rather than
    // waiting out the stale-claim TTL.
    await prisma.order.updateMany({
      where: { id: orderId, razorpayOrderId: null },
      data: { paymentAttemptedAt: null },
    });
    throw error;
  }

  // Guarded write: the unique constraint on razorpayOrderId is the DB-level
  // backstop, and `razorpayOrderId: null` here means we never clobber a value
  // another request somehow recorded first.
  const recorded = await prisma.order.updateMany({
    where: { id: orderId, razorpayOrderId: null },
    data: { razorpayOrderId: rpOrder.id },
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

  const record = await prisma.webhookEvent.upsert({
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

  if (record.processed) {
    return { received: true, status: 'already_processed' };
  }

  // Step 4+5: Process and mark as processed in a single transaction
  try {
    await processWebhookEvent(eventType, event, eventId);
  } catch (error) {
    // Log the error but still return 200 to Razorpay so it stops retrying.
    // The reconciliation job will pick up unprocessed events.
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await prisma.webhookEvent.update({
      where: { eventId },
      data: { processingError: errorMessage },
    });
    console.error(`⚠️ Webhook processing failed for event ${eventId}:`, errorMessage);
    return { received: true, status: 'processing_failed' };
  }

  return { received: true, status: 'processed' };
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
  request: { id: string; orderId: string; shopId: string; status: RefundRequestStatus },
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
      refundStatus: 'processed',
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
      eventId: `refund:${request.id}`,
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
  request: { id: string; orderId: string; shopId: string; status: RefundRequestStatus },
  outboxIds: string[]
): Promise<RefundParty | null> {
  // Guarding on the statuses that imply a deduction was actually made stops a
  // second arrival from crediting the shop twice.
  if (!['RESOLVED_REFUNDED', 'PROCESSING_REFUND'].includes(request.status)) return null;

  const deducted = await tx.ledgerEntry.findUnique({
    where: { eventId: `refund:${request.id}` },
  });

  if (deducted) {
    await ledgerService.createLedgerEntry({
      shopId: request.shopId,
      type: 'ADJUSTMENT',
      amount: deducted.amount,
      description: `Reversal — Razorpay refund failed for order ${request.orderId}`,
      counterparty: 'PLATFORM',
      createdBy: 'SYSTEM',
      orderId: request.orderId,
      eventId: `refund:${request.id}:reversal`,
    }, tx, outboxIds);
  }

  const moved = await tx.refundRequest.updateMany({
    where: { id: request.id, status: request.status },
    data: { status: 'REFUND_FAILED' },
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
    data: { refundStatus: 'FAILED', refundError: 'Refund failed at the gateway' },
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
        // The signature proves Razorpay sent this, not that the sum is right.
        if (payment.amount !== env.STUDENT_PASS_PRICE_PAISE) {
          console.error(
            `⚠️ Student Pass paid ${payment.amount} but the price is ` +
            `${env.STUDENT_PASS_PRICE_PAISE} (payment ${rpPaymentId}) — not activating.`
          );
        } else {
          await activateStudentPass(payment.notes.userId, rpPaymentId);
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

        if (order && !amountMatches) {
          // Money moved and we are declining to fulfil against it, so somebody
          // has to be told. A console line in a log nobody reads is how a
          // student ends up out of pocket with the order still showing unpaid.
          mismatchedOrderId = order.id;
          mismatchReason =
            `captured ${payment.amount} paise but the order costs ${order.totalPrice} ` +
            `(payment ${rpPaymentId})`;
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

        if (order && claimable && amountMatches) {
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

  // Also retry any unprocessed webhook events
  const unprocessedEvents = await prisma.webhookEvent.findMany({
    where: {
      processed: false,
      createdAt: { lt: threshold },
    },
  });

  for (const webhookEvent of unprocessedEvents) {
    try {
      const payload = webhookEvent.payload as any;
      await processWebhookEvent(webhookEvent.eventType, payload, webhookEvent.eventId);
      console.log(`🔄 Reprocessed webhook event ${webhookEvent.eventId}`);
    } catch (error) {
      console.error(`❌ Failed to reprocess webhook ${webhookEvent.eventId}:`, error);
    }
  }

  return {
    checked: stuckOrders.length,
    reconciled,
    /** Payments that moved money we could not match to an order. Admins alerted. */
    flagged,
    retriedWebhooks: unprocessedEvents.length,
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
export async function createStudentPassOrder(userId: string) {
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

  const razorpay = getRazorpay();
  const rpOrder = await razorpay.orders.create({
    amount: env.STUDENT_PASS_PRICE_PAISE,
    currency: 'INR',
    // Unique per attempt: Razorpay rejects a duplicate receipt, and a retry
    // after an abandoned checkout must not collide with the earlier attempt.
    receipt: `pass_${userId.slice(-8)}_${Date.now()}`,
    notes: {
      userId,
      subscription_type: 'student_pass',
    },
  });

  return {
    razorpayOrderId: rpOrder.id,
    amount: env.STUDENT_PASS_PRICE_PAISE,
    currency: 'INR',
    key: env.RAZORPAY_KEY_ID,
  };
}

/**
 * Turn a paid pass payment into an active pass.
 *
 * Idempotent through `studentPassPaymentId`: re-running with the same payment
 * id matches no row and changes nothing, so a verify call racing the webhook
 * cannot grant two passes or move the expiry forward twice. A *different*
 * payment id is allowed through, which is what makes renewal work.
 *
 * Returns whether this call was the one that activated it.
 */
export async function activateStudentPass(userId: string, paymentId: string): Promise<boolean> {
  const activated = await prisma.user.updateMany({
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
      studentPassActivatedAt: new Date(),
      studentPassPaymentId: paymentId,
    },
  });
  return activated.count > 0;
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

  await activateStudentPass(userId, razorpayPaymentId);

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
}

/** Razorpay caps a page at 100. */
const AUDIT_PAGE_SIZE = 100;

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
  // Bounded so a wide window cannot spin: 10 pages is 1000 payments, far more
  // than this platform sees in a day, and the window is the real control.
  for (let page = 0; page < 10; page++) {
    const response = (await razorpay.payments.all({
      from: Math.floor(windowStart.getTime() / 1000),
      count: AUDIT_PAGE_SIZE,
      skip,
    })) as unknown as { items?: RazorpayPayment[] };

    const items: RazorpayPayment[] = response?.items ?? [];
    captured.push(...items.filter((p) => p?.status === 'captured'));

    if (items.length < AUDIT_PAGE_SIZE) break;
    skip += AUDIT_PAGE_SIZE;
  }

  let skippedTooRecent = 0;
  const orphans: OrphanPayment[] = [];

  for (const payment of captured) {
    const capturedAt = new Date((payment.created_at ?? 0) * 1000);
    if (capturedAt > graceCutoff) {
      skippedTooRecent++;
      continue;
    }

    // Student Pass payments are not orders and have no order row by design.
    if (payment?.notes?.subscription_type === 'student_pass') continue;

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
