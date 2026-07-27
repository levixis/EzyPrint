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
  keyId: string;       // Razorpay key ID for frontend
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

  // ── Upgrade C: Idempotency on order-creation ──
  // If a Razorpay order already exists for this order, return it.
  // This prevents the double-charge scenario where a student retries
  // payment while reconciliation hasn't caught up yet.
  if (order.razorpayOrderId && order.status === 'PENDING_PAYMENT') {
    return {
      razorpayOrderId: order.razorpayOrderId,
      amount: Math.round(order.totalPrice * 100),
      currency: 'INR',
      orderId: orderId,
      keyId: env.RAZORPAY_KEY_ID,
    };
  }

  if (order.status !== 'PENDING_PAYMENT') {
    throw ApiError.badRequest(`Order is in ${order.status} status, not PENDING_PAYMENT`);
  }

  const amountInPaise = Math.round(order.totalPrice * 100);
  if (amountInPaise < 100) {
    throw ApiError.badRequest('Minimum order amount is ₹1');
  }

  const razorpay = getRazorpay();

  const rpOrder = await razorpay.orders.create({
    amount: amountInPaise,
    currency: 'INR',
    receipt: orderId,
    notes: {
      orderId: orderId,
      userId: userId,
      shopId: order.shopId,
    },
  });

  await prisma.order.update({
    where: { id: orderId },
    data: {
      razorpayOrderId: rpOrder.id,
      paymentAttemptedAt: new Date(),
    },
  });

  return {
    razorpayOrderId: rpOrder.id,
    amount: amountInPaise,
    currency: 'INR',
    orderId: orderId,
    keyId: env.RAZORPAY_KEY_ID,
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

  if (expectedSignature !== razorpaySignature) {
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'PAYMENT_FAILED',
        paymentVerifiedVia: 'signature_mismatch',
      },
    });
    throw ApiError.badRequest('Payment verification failed — signature mismatch');
  }

  const updatedOrder = await prisma.order.update({
    where: { id: orderId },
    data: {
      status: 'PENDING_APPROVAL',
      razorpayPaymentId,
      paymentVerifiedVia: 'signature',
    },
  });

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

  if (expectedSignature !== signature) {
    throw ApiError.unauthorized('Invalid webhook signature');
  }

  const event = JSON.parse(rawBody);
  const eventId = event.id; // Razorpay's unique event ID
  const eventType = event.event;

  if (!eventId) {
    throw ApiError.badRequest('Webhook payload missing event.id');
  }

  // Step 2: Check idempotency — has this event already been processed?
  const existing = await prisma.webhookEvent.findUnique({
    where: { eventId },
  });

  if (existing?.processed) {
    // Already processed — return 200 idempotently
    return { received: true, status: 'already_processed' };
  }

  // Step 3: Log the raw event (even if processing fails later)
  const rpOrderId = event.payload?.payment?.entity?.order_id || null;

  if (!existing) {
    await prisma.webhookEvent.create({
      data: {
        source: 'razorpay',
        eventId,
        eventType,
        razorpayOrderId: rpOrderId,
        payload: event,
      },
    });
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
    return { reconciled: 0, checked: 0 };
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
