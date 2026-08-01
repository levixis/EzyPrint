import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { sensitiveLimiter, orderCreationLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { createOrderSchema, updateOrderStatusSchema, listOrdersSchema } from '../validators/schemas';
import * as orderController from '../controllers/order.controller';

const router = Router();

/**
 * IMPORTANT: /admin/all must be defined BEFORE /:orderId
 */

router.get('/admin/all', authenticate, authorize('ADMIN'), validate(listOrdersSchema), orderController.listAllOrders);
router.post('/', authenticate, authorize('STUDENT'), orderCreationLimiter, validate(createOrderSchema), orderController.createOrder);
router.get('/', authenticate, orderController.listOrders);
router.get('/:orderId', authenticate, orderController.getOrder);
router.patch('/:orderId/status', authenticate, authorize('SHOP_OWNER', 'ADMIN', 'STUDENT'), validate(updateOrderStatusSchema), orderController.updateStatus);

/**
 * Payment endpoints at /api/v1/payments/
 */

router.post('/:orderId/refund', authenticate, authorize('STUDENT'), sensitiveLimiter, (_req, res) => {
  res.status(501).json({ success: false, message: 'Request refund — not yet implemented' });
});

export default router;
