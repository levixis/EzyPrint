import Razorpay from 'razorpay';
import crypto from 'crypto';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';
import * as ledgerService from './ledger.service';
import * as realtimeService from './realtime.service';
import * as orderService from './order.service';

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

// ────────────────────────────────────────────────────────────
// CREATE PAYMENT ORDER
// ────────────────────────────────────────────────────────────

interface CreatePaymentResult {
  razorpayOrderId: string;
  amount: number;      // in paise (₹1 = 100 paise)
  currency: string;
  orderId: string;     // our internal order ID
  key: string;       // Razorpay key ID for frontend
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
  if (!preflight.razorpayOrderId && preflight.status === 'PENDING_PAYMENT') {
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
  await prisma.order.updateMany({
    where: { id: orderId, status: 'PENDING_PAYMENT' },
    data: {
      status: 'PENDING_APPROVAL',
      razorpayPaymentId,
      paymentVerifiedVia: 'signature',
    },
  });

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
          console.error(
            `⚠️ Amount mismatch on order ${order.id}: paid ${payment.amount}, ` +
            `expected ${order.totalPrice} (payment ${rpPaymentId}) — leaving unpaid for review.`
          );
        }

        // Only process if order exists, is still pending payment, and the sum agrees
        if (order && order.status === 'PENDING_PAYMENT' && amountMatches) {
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: 'PENDING_APPROVAL',
              razorpayPaymentId: rpPaymentId,
              paymentVerifiedVia: 'webhook',
            },
          });
        }

        // Mark webhook as processed (inside the same transaction)
        await tx.webhookEvent.update({
          where: { eventId },
          data: { processed: true, processedAt: new Date() },
        });
      });
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
     * Normally a no-op: the admin resolve flow already recorded everything
     * synchronously. It matters when that flow crashed *after* Razorpay
     * accepted the refund but *before* the local transaction committed —
     * leaving the request stuck in PROCESSING_REFUND with the student refunded
     * and the shop's ledger untouched. Completing it here closes that window.
     *
     * The ledger write reuses `refund:<id>` as its eventId, so if the original
     * transaction did commit this finds the existing entry and moves no money.
     */
    case 'refund.processed': {
      const refund = event.payload.refund.entity;
      const outboxIds: string[] = [];

      await prisma.$transaction(async (tx) => {
        const request = await findRefundRequest(tx, refund);

        if (request && request.status === 'PROCESSING_REFUND') {
          await tx.refundRequest.updateMany({
            where: { id: request.id, status: 'PROCESSING_REFUND' },
            data: {
              status: 'RESOLVED_REFUNDED',
              razorpayRefundId: refund.id,
              adminResolvedAt: new Date(),
              refundAmount: refund.amount,
            },
          });

          await tx.order.updateMany({
            where: { id: request.orderId },
            data: { status: 'REFUNDED' },
          });

          // Same split as the admin resolve path: the shop is liable only for
          // what it actually received, never for the platform's base fee.
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
        }

        await tx.webhookEvent.update({
          where: { eventId },
          data: { processed: true, processedAt: new Date() },
        });
      });

      await realtimeService.publishQueued(outboxIds);
      break;
    }

    /**
     * Razorpay failed the refund after accepting it.
     *
     * The student's money never moved, so the shop must not stay charged. A
     * compensating ADJUSTMENT credit reverses the deduction rather than
     * deleting the original entry — the ledger stays append-only, so both the
     * attempt and its reversal remain auditable.
     *
     * ADJUSTMENT is the exact mirror of REFUND_DEDUCTION: same CLEARING
     * bucket, opposite direction. Credits pay down `debtAmount` first, which
     * is what should happen when the refund had pushed the shop negative.
     *
     * The reversal's own `refund:<id>:reversal` eventId makes redelivery of
     * this webhook harmless.
     */
    case 'refund.failed': {
      const refund = event.payload.refund.entity;
      const outboxIds: string[] = [];

      await prisma.$transaction(async (tx) => {
        const request = await findRefundRequest(tx, refund);

        // Guarding on the statuses that imply a deduction was actually made
        // stops a redelivered failure from crediting the shop twice.
        if (request && ['RESOLVED_REFUNDED', 'PROCESSING_REFUND'].includes(request.status)) {
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

          await tx.refundRequest.updateMany({
            where: { id: request.id, status: request.status },
            data: { status: 'REFUND_FAILED' },
          });

          // The order was never actually refunded. Returning it to COMPLETED
          // is the least-wrong terminal state: the print was delivered, and
          // only the refund attempt failed. An admin retries from the
          // REFUND_FAILED request.
          await tx.order.updateMany({
            where: { id: request.orderId, status: 'REFUNDED' },
            data: { status: 'COMPLETED' },
          });
        }

        await tx.webhookEvent.update({
          where: { eventId },
          data: { processed: true, processedAt: new Date() },
        });
      });

      await realtimeService.publishQueued(outboxIds);
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

  // Find orders stuck in PENDING_PAYMENT with a Razorpay order ID
  // that were created more than `thresholdMinutes` ago
  const stuckOrders = await prisma.order.findMany({
    where: {
      status: 'PENDING_PAYMENT',
      razorpayOrderId: { not: null },
      paymentAttemptedAt: { lt: threshold },
    },
    select: {
      id: true,
      razorpayOrderId: true,
      totalPrice: true,
    },
  });

  if (stuckOrders.length === 0) {
    return { reconciled: 0, checked: 0, retriedWebhooks: 0 };
  }

  const razorpay = getRazorpay();
  let reconciled = 0;

  for (const order of stuckOrders) {
    try {
      // Ask Razorpay: "What's the actual status of this order?"
      const rpOrder = await razorpay.orders.fetch(order.razorpayOrderId!);

      if (rpOrder.status === 'paid') {
        // Razorpay says paid but our DB says pending — the webhook was missed.
        // Fetch the payment details to get the payment ID
        const payments = await razorpay.orders.fetchPayments(order.razorpayOrderId!);
        const capturedPayment = (payments as any).items?.find(
          (p: any) => p.status === 'captured'
        );

        if (capturedPayment) {
          await prisma.order.update({
            where: { id: order.id },
            data: {
              status: 'PENDING_APPROVAL',
              razorpayPaymentId: capturedPayment.id,
              paymentVerifiedVia: 'reconciliation',
            },
          });
          reconciled++;
          console.log(`🔄 Reconciled order ${order.id} — payment ${capturedPayment.id}`);
        }
      }
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
    retriedWebhooks: unprocessedEvents.length,
  };
}

// ────────────────────────────────────────────────────────────
// STUDENT PASS
// ────────────────────────────────────────────────────────────

/** How long a pass lasts. Mirrors isStudentPassActive in order.service.ts. */
const PASS_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

function passIsActive(hasPass: boolean, activatedAt: Date | null): boolean {
  if (!hasPass || !activatedAt) return false;
  return Date.now() < activatedAt.getTime() + PASS_DURATION_MS;
}

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
  if (passIsActive(user.hasStudentPass, user.studentPassActivatedAt)) {
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
    where: { id: userId, studentPassPaymentId: { not: paymentId } },
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
