import { Router } from 'express';
import { authenticate } from '../middleware/auth';

const router = Router();

/**
 * POST /api/v1/tickets
 * Create a new support ticket
 */
router.post('/', authenticate, (_req, res) => {
  res.status(501).json({ success: false, message: 'Create ticket — coming in Phase 6' });
});

/**
 * GET /api/v1/tickets
 * List tickets for current user (admin sees all)
 */
router.get('/', authenticate, (_req, res) => {
  res.status(501).json({ success: false, message: 'List tickets — coming in Phase 6' });
});

/**
 * GET /api/v1/tickets/:ticketId
 * Get ticket details with messages
 */
router.get('/:ticketId', authenticate, (_req, res) => {
  res.status(501).json({ success: false, message: 'Get ticket — coming in Phase 6' });
});

/**
 * POST /api/v1/tickets/:ticketId/messages
 * Add a message to a ticket
 */
router.post('/:ticketId/messages', authenticate, (_req, res) => {
  res.status(501).json({ success: false, message: 'Add ticket message — coming in Phase 6' });
});

/**
 * PATCH /api/v1/tickets/:ticketId/status
 * Update ticket status
 */
router.patch('/:ticketId/status', authenticate, (_req, res) => {
  res.status(501).json({ success: false, message: 'Update ticket status — coming in Phase 6' });
});

export default router;
