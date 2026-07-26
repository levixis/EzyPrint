import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

/**
 * GET /api/v1/users/me
 * Get current user profile
 */
router.get('/me', authenticate, (_req, res) => {
  res.status(501).json({ success: false, message: 'Get profile — coming in Phase 3' });
});

/**
 * PATCH /api/v1/users/me
 * Update current user profile
 */
router.patch('/me', authenticate, (_req, res) => {
  res.status(501).json({ success: false, message: 'Update profile — coming in Phase 3' });
});

/**
 * GET /api/v1/users (Admin only)
 * List all users
 */
router.get('/', authenticate, authorize('ADMIN'), (_req, res) => {
  res.status(501).json({ success: false, message: 'List users — coming in Phase 3' });
});

export default router;
