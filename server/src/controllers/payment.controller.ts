import { Request, Response, NextFunction } from 'express';
import * as paymentService from '../services/payment.service';
import { ApiError } from '../utils/ApiError';

/**
 * Payment Controller — handles Razorpay payment flow.
 */

/**
 * POST /api/v1/payments/create-order
 * Create a Razorpay payment order for an existing EzyPrint order.
 * Body: { orderId }
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
 */
export async function verifyPayment(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body;

    if (!orderId || !razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
      throw ApiError.badRequest('orderId, razorpayPaymentId, razorpayOrderId, and razorpaySignature are required');
    }

    const order = await paymentService.verifyPayment(
      { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature },
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
 * IMPORTANT: This endpoint must receive the RAW body, not parsed JSON.
 * We handle this in the route by using express.raw().
 */
export async function webhook(req: Request, res: Response, next: NextFunction) {
  try {
    const signature = req.headers['x-razorpay-signature'] as string;
    if (!signature) throw ApiError.badRequest('Missing webhook signature');

    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    if (!webhookSecret) {
      // If no webhook secret configured, just acknowledge
      return res.json({ received: true });
    }

    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const result = await paymentService.handleWebhook(rawBody, signature, webhookSecret);

    res.json(result);
  } catch (error) {
    next(error);
  }
}
