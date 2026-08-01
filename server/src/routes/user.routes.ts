import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { updateProfileSchema, listUsersSchema, pushTokenSchema } from '../validators/schemas';
import * as userController from '../controllers/user.controller';

const router = Router();

router.get('/me', authenticate, userController.getProfile);
router.patch('/me', authenticate, validate(updateProfileSchema), userController.updateProfile);

// Device push registration — the client posts its FCM token here after login
// and withdraws it on logout.
// Withdrawal is a POST rather than a DELETE because it carries the token in
// the body, and DELETE bodies are stripped by some proxies.
router.post('/me/push-token', authenticate, validate(pushTokenSchema), userController.registerPushToken);
router.post('/me/push-token/remove', authenticate, validate(pushTokenSchema), userController.unregisterPushToken);
router.get('/', authenticate, authorize('ADMIN'), validate(listUsersSchema), userController.listUsers);

export default router;
