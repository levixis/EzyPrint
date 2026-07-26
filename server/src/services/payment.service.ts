import Razorpay from 'razorpay';
import crypto from 'crypto';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';

/**
 * Payment Service — Razorpay integration for order payments.
 *
 * Flow (interview-ready):
 * 1. Student creates an order → status: PENDING_PAYMENT
 * 2. Frontend calls createPaymentOrder() → gets Razorpay order_id
 * 3. Frontend opens Razorpay checkout with that order_id
 * 4. After payment, frontend sends signature to verifyPayment()
 * 5. We verify the signature using HMAC SHA-256 with our secret
 * 6. If valid → update order to PENDING_APPROVAL + record payment IDs
 *
 * Security: The signature verification ensures the payment came from
 * Razorpay and wasn't tampered with by the client.
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
 * The student must own the order, and it must be in PENDING_PAYMENT status.
 */
export async function createPaymentOrder(
  orderId: string,
  userId: string
): Promise<CreatePaymentResult> {
  // Fetch the order
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.userId !== userId) throw ApiError.forbidden('This is not your order');
  if (order.status !== 'PENDING_PAYMENT') {
    throw ApiError.badRequest(`Order is in ${order.status} status, not PENDING_PAYMENT`);
  }

  // Amount in paise (Razorpay uses smallest currency unit)
  const amountInPaise = Math.round(order.totalPrice * 100);

  if (amountInPaise < 100) {
    throw ApiError.badRequest('Minimum order amount is ₹1');
  }

  const razorpay = getRazorpay();

  // Create Razorpay order
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

  // Save Razorpay order ID to our order
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
// VERIFY PAYMENT
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
 * Signature verification formula:
 *   generated_signature = HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, key_secret)
 *   if generated_signature === razorpay_signature → payment is authentic
 *
 * This prevents the client from faking a successful payment.
 */
export async function verifyPayment(
  input: VerifyPaymentInput,
  userId: string
) {
  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = input;

  // Fetch order
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.userId !== userId) throw ApiError.forbidden('This is not your order');
  if (order.status !== 'PENDING_PAYMENT') {
    throw ApiError.badRequest('Order is not awaiting payment');
  }

  // Verify that the razorpayOrderId matches what we stored
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
    // Payment verification failed — mark as PAYMENT_FAILED
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'PAYMENT_FAILED',
        paymentVerifiedVia: 'signature_mismatch',
      },
    });
    throw ApiError.badRequest('Payment verification failed — signature mismatch');
  }

  // Payment verified! Update order status
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
// WEBHOOK (Razorpay server-to-server callback)
// ────────────────────────────────────────────────────────────

/**
 * Handle Razorpay webhook events.
 *
 * Razorpay sends a POST to our webhook URL with payment events.
 * We verify the webhook signature using the webhook secret.
 *
 * This is a fallback — if the client-side verification fails or
 * the user closes the browser, the webhook still processes the payment.
 */
export async function handleWebhook(
  rawBody: string,
  signature: string,
  webhookSecret: string
) {
  // Verify webhook signature
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  if (expectedSignature !== signature) {
    throw ApiError.unauthorized('Invalid webhook signature');
  }

  const event = JSON.parse(rawBody);

  switch (event.event) {
    case 'payment.captured': {
      const payment = event.payload.payment.entity;
      const rpOrderId = payment.order_id;
      const rpPaymentId = payment.id;

      // Find order by Razorpay order ID
      const order = await prisma.order.findFirst({
        where: { razorpayOrderId: rpOrderId },
      });

      if (order && order.status === 'PENDING_PAYMENT') {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: 'PENDING_APPROVAL',
            razorpayPaymentId: rpPaymentId,
            paymentVerifiedVia: 'webhook',
          },
        });
      }
      break;
    }

    case 'payment.failed': {
      const payment = event.payload.payment.entity;
      const rpOrderId = payment.order_id;

      const order = await prisma.order.findFirst({
        where: { razorpayOrderId: rpOrderId },
      });

      if (order && order.status === 'PENDING_PAYMENT') {
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: 'PAYMENT_FAILED',
            paymentVerifiedVia: 'webhook_failed',
          },
        });
      }
      break;
    }

    default:
      // Ignore other events
      break;
  }

  return { received: true };
}
