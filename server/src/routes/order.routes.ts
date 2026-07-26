import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { sensitiveLimiter } from '../middleware/rateLimiter';

const router = Router();

/**
 * POST /api/v1/orders
 * Create a new print order (student)
 */
router.post('/', authenticate, authorize('STUDENT'), (_req, res) => {
  res.status(501).json({ success: false, message: 'Create order — coming in Phase 3' });
});

/**
 * GET /api/v1/orders
 * Get orders for current user (student sees their orders, shop sees shop orders)
 */
router.get('/', authenticate, (_req, res) => {
  res.status(501).json({ success: false, message: 'List orders — coming in Phase 3' });
});

/**
 * GET /api/v1/orders/:orderId
 * Get single order details
 */
router.get('/:orderId', authenticate, (_req, res) => {
  res.status(501).json({ success: false, message: 'Get order — coming in Phase 3' });
});

/**
 * PATCH /api/v1/orders/:orderId/status
 * Update order status (shop owner or admin)
 */
router.patch('/:orderId/status', authenticate, authorize('SHOP_OWNER', 'ADMIN'), (_req, res) => {
  res.status(501).json({ success: false, message: 'Update order status — coming in Phase 3' });
});

/**
 * POST /api/v1/orders/:orderId/verify-payment
 * Verify Razorpay payment for an order
 */
router.post('/:orderId/verify-payment', authenticate, sensitiveLimiter, (_req, res) => {
  res.status(501).json({ success: false, message: 'Verify payment — coming in Phase 5' });
});

/**
 * POST /api/v1/orders/:orderId/refund
 * Request a refund for an order (student)
 */
router.post('/:orderId/refund', authenticate, authorize('STUDENT'), sensitiveLimiter, (_req, res) => {
  res.status(501).json({ success: false, message: 'Request refund — coming in Phase 6' });
});

/**
 * GET /api/v1/orders/admin/all
 * Admin: get all orders across all shops
 */
router.get('/admin/all', authenticate, authorize('ADMIN'), (_req, res) => {
  res.status(501).json({ success: false, message: 'Admin list all orders — coming in Phase 3' });
});

export default router;
