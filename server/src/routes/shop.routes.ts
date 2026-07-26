import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import * as shopController from '../controllers/shop.controller';

const router = Router();

/**
 * GET /api/v1/shops — List shops
 * Students: approved, non-archived shops. Query: ?onlyOpen=true
 * Admin: all shops including unapproved/archived
 */
router.get('/', shopController.listShops);

/**
 * GET /api/v1/shops/:shopId — Get shop details
 */
router.get('/:shopId', shopController.getShop);

/**
 * PATCH /api/v1/shops/:shopId — Update shop settings
 * Body: { bwPerPage?, colorPerPage?, isOpen?, contactPhone?, ... }
 */
router.patch('/:shopId', authenticate, authorize('SHOP_OWNER', 'ADMIN'), shopController.updateShopSettings);

/**
 * PATCH /api/v1/shops/:shopId/approve — Admin approves a shop
 */
router.patch('/:shopId/approve', authenticate, authorize('ADMIN'), shopController.approveShop);

/**
 * PATCH /api/v1/shops/:shopId/archive — Admin archives/unarchives a shop
 * Body: { action: 'archive' | 'unarchive' }
 */
router.patch('/:shopId/archive', authenticate, authorize('ADMIN'), shopController.archiveShop);

/**
 * GET /api/v1/shops/:shopId/aggregate — Shop dashboard stats
 */
router.get('/:shopId/aggregate', authenticate, authorize('SHOP_OWNER', 'ADMIN'), shopController.getAggregate);

export default router;
