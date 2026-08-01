import Razorpay from 'razorpay';
import crypto from 'crypto';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';

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
  webhookSecret: string
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
  const eventId = event.id; // Razorpay's unique event ID
  const eventType = event.event;

  if (!eventId) {
    throw ApiError.badRequest('Webhook payload missing event.id');
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
async function processWebhookEvent(eventType: string, event: any, eventId: string) {
  switch (eventType) {
    case 'payment.captured': {
      const payment = event.payload.payment.entity;
      const rpOrderId = payment.order_id;
      const rpPaymentId = payment.id;

      await prisma.$transaction(async (tx) => {
        const order = await tx.order.findFirst({
          where: { razorpayOrderId: rpOrderId },
        });

        // Only process if order exists and is still pending payment
        if (order && order.status === 'PENDING_PAYMENT') {
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
