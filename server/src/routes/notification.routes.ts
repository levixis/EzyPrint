import { Router } from 'express';
import { authenticate } from '../middleware/auth';

const router = Router();

/**
 * GET /api/v1/notifications
 * Get notifications for current user
 */
router.get('/', authenticate, (_req, res) => {
  res.status(501).json({ success: false, message: 'List notifications — coming in Phase 6' });
});

/**
 * PATCH /api/v1/notifications/:notificationId/read
 * Mark a notification as read
 */
router.patch('/:notificationId/read', authenticate, (_req, res) => {
  res.status(501).json({ success: false, message: 'Mark read — coming in Phase 6' });
});

/**
 * PATCH /api/v1/notifications/read-all
 * Mark all notifications as read
 */
router.patch('/read-all', authenticate, (_req, res) => {
  res.status(501).json({ success: false, message: 'Mark all read — coming in Phase 6' });
});

export default router;
