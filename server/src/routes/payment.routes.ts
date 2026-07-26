import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { sensitiveLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { createPaymentOrderSchema, verifyPaymentSchema } from '../validators/schemas';
import * as paymentController from '../controllers/payment.controller';

const router = Router();

router.post('/create-order', authenticate, sensitiveLimiter, validate(createPaymentOrderSchema), paymentController.createPaymentOrder);
router.post('/verify', authenticate, sensitiveLimiter, validate(verifyPaymentSchema), paymentController.verifyPayment);
router.post('/webhook', paymentController.webhook);

export default router;
