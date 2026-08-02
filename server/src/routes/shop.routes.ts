import { Router } from 'express';
import { authenticate, authorize, optionalAuthenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { updateShopSchema, archiveShopSchema, saveBankDetailsSchema } from '../validators/schemas';
import * as shopController from '../controllers/shop.controller';

const router = Router();

router.get('/', optionalAuthenticate, shopController.listShops);
// `optionalAuthenticate`, not none: an anonymous caller still gets the public
// view of a shop, but a signed-in owner or admin is identified so the service
// can widen the projection. Previously this had no authentication at all and
// returned payout methods and balances to anyone holding a shop id.
router.get('/:shopId', optionalAuthenticate, shopController.getShop);
router.patch('/:shopId', authenticate, authorize('SHOP_OWNER', 'ADMIN'), validate(updateShopSchema), shopController.updateShopSettings);
router.patch('/:shopId/approve', authenticate, authorize('ADMIN'), shopController.approveShop);
router.patch('/:shopId/archive', authenticate, authorize('ADMIN'), validate(archiveShopSchema), shopController.archiveShop);
router.get('/:shopId/aggregate', authenticate, authorize('SHOP_OWNER', 'ADMIN'), shopController.getAggregate);
router.get('/:shopId/bank-details', authenticate, authorize('SHOP_OWNER', 'ADMIN'), shopController.getBankDetails);
router.post('/:shopId/bank-details', authenticate, authorize('SHOP_OWNER', 'ADMIN'), validate(saveBankDetailsSchema), shopController.saveBankDetails);
router.post('/:shopId/bank-details/verify', authenticate, authorize('ADMIN'), shopController.verifyBankDetails);
router.get('/:shopId/payment-config', authenticate, authorize('SHOP_OWNER', 'ADMIN'), shopController.getPaymentConfig);

export default router;
