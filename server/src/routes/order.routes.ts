import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { sensitiveLimiter } from '../middleware/rateLimiter';
import * as orderController from '../controllers/order.controller';

const router = Router();

/**
 * IMPORTANT: /admin/all must be defined BEFORE /:orderId
 * otherwise Express treats "admin" as an orderId parameter.
 */

/**
 * GET /api/v1/orders/admin/all — Admin: list all orders
 * Query: ?status=PRINTING&shopId=xxx&page=1&limit=20
 */
router.get('/admin/all', authenticate, authorize('ADMIN'), orderController.listAllOrders);

/**
 * POST /api/v1/orders — Create a new print order (student)
 * Body: { shopId, fileName, fileType, copies, color, pages, doubleSided, ... }
 */
router.post('/', authenticate, authorize('STUDENT'), orderController.createOrder);

/**
 * GET /api/v1/orders — List orders for current user
 * Student: their orders. Shop owner: their shop's orders.
 * Query: ?status=PRINTING&page=1&limit=20
 */
router.get('/', authenticate, orderController.listOrders);

/**
 * GET /api/v1/orders/:orderId — Get single order details
 */
router.get('/:orderId', authenticate, orderController.getOrder);

/**
 * PATCH /api/v1/orders/:orderId/status — Update order status
 * Body: { status: 'PRINTING', shopNotes?: 'Your order is being printed' }
 */
router.patch('/:orderId/status', authenticate, authorize('SHOP_OWNER', 'ADMIN'), orderController.updateStatus);

/**
 * Payment endpoints moved to /api/v1/payments/
 *   POST /payments/create-order — Create Razorpay order
 *   POST /payments/verify       — Verify payment signature
 *   POST /payments/webhook      — Razorpay webhook
 */

/**
 * POST /api/v1/orders/:orderId/refund — Request refund
 * → Phase 6 implementation
 */
router.post('/:orderId/refund', authenticate, authorize('STUDENT'), sensitiveLimiter, (_req, res) => {
  res.status(501).json({ success: false, message: 'Request refund — coming in Phase 6' });
});

export default router;
