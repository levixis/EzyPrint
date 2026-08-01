import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import * as referralController from '../controllers/referral.controller';

const router = Router();

// All referral routes are admin-only
router.use(authenticate, authorize('ADMIN'));

router.get('/', referralController.listReferralCodes);
router.post('/', referralController.createReferralCode);
router.delete('/:codeId', referralController.deleteReferralCode);

export default router;
