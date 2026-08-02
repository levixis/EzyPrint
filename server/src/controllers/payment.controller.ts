import { Request, Response, NextFunction } from 'express';
import * as paymentService from '../services/payment.service';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';
import { clampThresholdMinutes } from '../utils/pagination';

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
    const headerEventId = req.headers['x-razorpay-event-id'] as string | undefined;
    const result = await paymentService.handleWebhook(rawBody, signature, webhookSecret, headerEventId);

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
 * Scans for orders that reached the gateway but never landed as paid here —
 * PENDING_PAYMENT and PAYMENT_FAILED alike, because the latter is written by
 * the client when the checkout sheet closes and is routinely wrong about a UPI
 * collect approved afterwards. Queries Razorpay for their true status and
 * fulfils any that were actually paid but whose webhook was missed. A capture
 * we cannot match to the order's price is flagged for an admin instead, never
 * silently reopened for payment.
 *
 * Also retries any WebhookEvent records that failed processing — independently
 * of the above, so a stuck webhook is retried even on a sweep that finds no
 * stuck orders.
 *
 * Called by: the in-process scheduler, or manually by an admin. `?threshold=0`
 * sweeps everything immediately rather than waiting out the 15-minute window,
 * which is what makes this testable by hand.
 */
export async function reconcile(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    if (req.user.userType !== 'ADMIN') {
      throw ApiError.forbidden('Only admins can trigger reconciliation');
    }

    // `|| 15` swallowed the one value an operator most wants: `?threshold=0`
    // parsed to 0, which is falsy, so "sweep everything now" silently became
    // the default 15-minute window and the sweep appeared to do nothing.
    const thresholdMinutes = clampThresholdMinutes(req.query.threshold);
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

/**
 * POST /api/v1/payments/pass/create-order
 */
export async function createStudentPassOrder(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const result = await paymentService.createStudentPassOrder(req.user.userId);
    res.status(201).json({ success: true, message: 'Student Pass order created', data: result });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/payments/pass/verify
 */
export async function verifyStudentPassPayment(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      throw ApiError.badRequest('razorpay_order_id, razorpay_payment_id and razorpay_signature are required');
    }

    const result = await paymentService.verifyStudentPassPayment(
      req.user.userId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );

    res.json({ success: true, message: 'Student Pass activated', data: result });
  } catch (error) {
    next(error);
  }
}
