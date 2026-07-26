import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

/**
 * POST /api/v1/payouts
 * Create a payout request (admin)
 */
router.post('/', authenticate, authorize('ADMIN'), (_req, res) => {
  res.status(501).json({ success: false, message: 'Create payout — coming in Phase 6' });
});

/**
 * GET /api/v1/payouts
 * List payouts (admin sees all, shop owner sees their own)
 */
router.get('/', authenticate, authorize('SHOP_OWNER', 'ADMIN'), (_req, res) => {
  res.status(501).json({ success: false, message: 'List payouts — coming in Phase 6' });
});

/**
 * PATCH /api/v1/payouts/:payoutId/status
 * Update payout status (admin: mark paid, shop: confirm receipt)
 */
router.patch('/:payoutId/status', authenticate, authorize('SHOP_OWNER', 'ADMIN'), (_req, res) => {
  res.status(501).json({ success: false, message: 'Update payout status — coming in Phase 6' });
});

/**
 * GET /api/v1/payouts/ledger/:shopId
 * Get ledger entries for a shop
 */
router.get('/ledger/:shopId', authenticate, authorize('SHOP_OWNER', 'ADMIN'), (_req, res) => {
  res.status(501).json({ success: false, message: 'Shop ledger — coming in Phase 6' });
});

export default router;
