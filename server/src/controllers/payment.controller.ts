import { Request, Response, NextFunction } from 'express';
import * as paymentService from '../services/payment.service';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';

/**
 * Payment Controller — Razorpay payment flow + reconciliation.
 */

/**
 * POST /api/v1/payments/create-order
 * Create a Razorpay payment order for an existing EzyPrint order.
 * Body: { orderId }
 *
 * Upgrade C: Idempotent — if a Razorpay order already exists for
 * this EzyPrint order, returns the existing one instead of creating a duplicate.
 */
export async function createPaymentOrder(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { orderId } = req.body;
    if (!orderId) throw ApiError.badRequest('orderId is required');

    const result = await paymentService.createPaymentOrder(orderId, req.user.userId);

    res.status(201).json({
      success: true,
      message: 'Payment order created',
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/payments/verify
 * Verify a Razorpay payment after checkout completion.
 * Body: { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature }
 *
 * Upgrade C: Idempotent — if the webhook already processed this payment,
 * returns success instead of throwing an error.
 */
export async function verifyPayment(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { orderId, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

    if (!orderId || !razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      throw ApiError.badRequest('orderId, razorpay_payment_id, razorpay_order_id, and razorpay_signature are required');
    }

    const order = await paymentService.verifyPayment(
      { orderId, razorpayPaymentId: razorpay_payment_id, razorpayOrderId: razorpay_order_id, razorpaySignature: razorpay_signature },
      req.user.userId
    );

    res.json({
      success: true,
      message: 'Payment verified successfully',
      data: { order },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/payments/webhook
 * Razorpay webhook handler — server-to-server callback.
 * No auth required (verified by webhook signature).
 *
 * Upgrade A: Logs raw payload to WebhookEvent table before processing.
 * Deduplicates on Razorpay's event.id. Processes business logic and
 * marks event as processed in a single Prisma transaction.
 */
export async function webhook(req: Request, res: Response, next: NextFunction) {
  try {
    const signature = req.headers['x-razorpay-signature'] as string;
    if (!signature) throw ApiError.badRequest('Missing webhook signature');

    const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      // If no webhook secret configured, just acknowledge
      return res.json({ received: true });
    }

    const rawBody = (req as any).rawBody
      ? (req as any).rawBody.toString()
      : typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body);
    const result = await paymentService.handleWebhook(rawBody, signature, webhookSecret);

    // Always return 200 to Razorpay — even if processing failed.
    // Failed events are retried by the reconciliation job, not by
    // asking Razorpay to re-send (which would double our load).
    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/payments/reconcile
 * Upgrade B: The safety net.
 *
 * Scans for orders stuck in PENDING_PAYMENT for over 15 minutes,
 * queries Razorpay for their true status, and fulfills any that
 * were actually paid but whose webhook was missed.
 *
 * Also retries any WebhookEvent records that failed processing.
 *
 * Called by: an external cron service every 15 minutes, or manually
 * by an admin for immediate reconciliation.
 */
export async function reconcile(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    if (req.user.userType !== 'ADMIN') {
      throw ApiError.forbidden('Only admins can trigger reconciliation');
    }

    const thresholdMinutes = parseInt(req.query.threshold as string) || 15;
    const result = await paymentService.reconcilePayments(thresholdMinutes);

    res.json({
      success: true,
      message: `Reconciliation complete: ${result.reconciled} orders recovered`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
