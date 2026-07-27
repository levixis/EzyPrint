import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { sensitiveLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { createPaymentOrderSchema, verifyPaymentSchema } from '../validators/schemas';
import * as paymentController from '../controllers/payment.controller';

const router = Router();

router.post('/create-order', authenticate, sensitiveLimiter, validate(createPaymentOrderSchema), paymentController.createPaymentOrder);
router.post('/verify', authenticate, sensitiveLimiter, validate(verifyPaymentSchema), paymentController.verifyPayment);
router.post('/webhook', paymentController.webhook);

// Upgrade B: Reconciliation endpoint — admin-only
router.post('/reconcile', authenticate, authorize('ADMIN'), paymentController.reconcile);

export default router;
