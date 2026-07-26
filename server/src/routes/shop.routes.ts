import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

/**
 * GET /api/v1/shops
 * List all approved, open shops (for students)
 */
router.get('/', (_req, res) => {
  res.status(501).json({ success: false, message: 'List shops — coming in Phase 3' });
});

/**
 * GET /api/v1/shops/:shopId
 * Get shop details
 */
router.get('/:shopId', (_req, res) => {
  res.status(501).json({ success: false, message: 'Get shop — coming in Phase 3' });
});

/**
 * POST /api/v1/shops
 * Register a new shop (shop owner)
 */
router.post('/', authenticate, authorize('SHOP_OWNER'), (_req, res) => {
  res.status(501).json({ success: false, message: 'Register shop — coming in Phase 3' });
});

/**
 * PATCH /api/v1/shops/:shopId
 * Update shop settings (pricing, status, contact info)
 */
router.patch('/:shopId', authenticate, authorize('SHOP_OWNER', 'ADMIN'), (_req, res) => {
  res.status(501).json({ success: false, message: 'Update shop — coming in Phase 3' });
});

/**
 * PATCH /api/v1/shops/:shopId/approve
 * Admin approves a shop
 */
router.patch('/:shopId/approve', authenticate, authorize('ADMIN'), (_req, res) => {
  res.status(501).json({ success: false, message: 'Approve shop — coming in Phase 3' });
});

/**
 * PATCH /api/v1/shops/:shopId/archive
 * Admin archives a shop
 */
router.patch('/:shopId/archive', authenticate, authorize('ADMIN'), (_req, res) => {
  res.status(501).json({ success: false, message: 'Archive shop — coming in Phase 3' });
});

/**
 * GET /api/v1/shops/:shopId/aggregate
 * Get shop dashboard aggregate stats
 */
router.get('/:shopId/aggregate', authenticate, authorize('SHOP_OWNER', 'ADMIN'), (_req, res) => {
  res.status(501).json({ success: false, message: 'Shop aggregate — coming in Phase 3' });
});

export default router;
