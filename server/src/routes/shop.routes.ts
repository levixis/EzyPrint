import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { updateShopSchema, archiveShopSchema } from '../validators/schemas';
import * as shopController from '../controllers/shop.controller';

const router = Router();

router.get('/', shopController.listShops);
router.get('/:shopId', shopController.getShop);
router.patch('/:shopId', authenticate, authorize('SHOP_OWNER', 'ADMIN'), validate(updateShopSchema), shopController.updateShopSettings);
router.patch('/:shopId/approve', authenticate, authorize('ADMIN'), shopController.approveShop);
router.patch('/:shopId/archive', authenticate, authorize('ADMIN'), validate(archiveShopSchema), shopController.archiveShop);
router.get('/:shopId/aggregate', authenticate, authorize('SHOP_OWNER', 'ADMIN'), shopController.getAggregate);

export default router;
