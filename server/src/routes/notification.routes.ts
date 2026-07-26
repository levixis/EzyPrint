import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as notifController from '../controllers/notification.controller';

const router = Router();

/**
 * GET /api/v1/notifications — List notifications
 * Query: ?page=1&limit=20&unreadOnly=true
 */
router.get('/', authenticate, notifController.getNotifications);

/**
 * PATCH /api/v1/notifications/read-all — Mark all as read
 */
router.patch('/read-all', authenticate, notifController.markAllAsRead);

/**
 * PATCH /api/v1/notifications/:notificationId/read — Mark one as read
 */
router.patch('/:notificationId/read', authenticate, notifController.markAsRead);

export default router;
