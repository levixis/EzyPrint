import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { sensitiveLimiter } from '../middleware/rateLimiter';
import * as paymentController from '../controllers/payment.controller';

const router = Router();

/**
 * POST /api/v1/payments/create-order
 * Create a Razorpay payment order for a pending-payment EzyPrint order.
 * Body: { orderId }
 */
router.post('/create-order', authenticate, sensitiveLimiter, paymentController.createPaymentOrder);

/**
 * POST /api/v1/payments/verify
 * Verify payment after Razorpay checkout completes.
 * Body: { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature }
 */
router.post('/verify', authenticate, sensitiveLimiter, paymentController.verifyPayment);

/**
 * POST /api/v1/payments/webhook
 * Razorpay webhook — no auth (verified by webhook signature).
 * Fallback for when client-side verification fails.
 */
router.post('/webhook', paymentController.webhook);

export default router;
