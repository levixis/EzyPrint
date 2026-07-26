import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { updateProfileSchema, listUsersSchema } from '../validators/schemas';
import * as userController from '../controllers/user.controller';

const router = Router();

router.get('/me', authenticate, userController.getProfile);
router.patch('/me', authenticate, validate(updateProfileSchema), userController.updateProfile);
router.get('/', authenticate, authorize('ADMIN'), validate(listUsersSchema), userController.listUsers);

export default router;
