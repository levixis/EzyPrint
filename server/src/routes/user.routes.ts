import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import * as userController from '../controllers/user.controller';

const router = Router();

/**
 * GET /api/v1/users/me — Get current user profile
 */
router.get('/me', authenticate, userController.getProfile);

/**
 * PATCH /api/v1/users/me — Update current user profile
 * Body: { name?, phone?, preferredLanguage?, profilePhotoUrl? }
 */
router.patch('/me', authenticate, userController.updateProfile);

/**
 * GET /api/v1/users — Admin: list all users with pagination
 * Query: ?page=1&limit=20&type=STUDENT&search=john
 */
router.get('/', authenticate, authorize('ADMIN'), userController.listUsers);

export default router;
