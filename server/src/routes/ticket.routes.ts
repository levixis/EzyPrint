import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import * as ticketController from '../controllers/ticket.controller';

const router = Router();

/**
 * POST /api/v1/tickets — Create a support ticket
 * Body: { subject, description, category, orderId?, shopId? }
 */
router.post('/', authenticate, ticketController.createTicket);

/**
 * GET /api/v1/tickets — List tickets (user's own, admin sees all)
 * Query: ?status=open&page=1&limit=20
 */
router.get('/', authenticate, ticketController.listTickets);

/**
 * GET /api/v1/tickets/:ticketId — Get ticket with messages
 */
router.get('/:ticketId', authenticate, ticketController.getTicket);

/**
 * POST /api/v1/tickets/:ticketId/messages — Add a message
 * Body: { message }
 */
router.post('/:ticketId/messages', authenticate, ticketController.addMessage);

/**
 * PATCH /api/v1/tickets/:ticketId/status — Update ticket status (admin)
 * Body: { status, note? }
 */
router.patch('/:ticketId/status', authenticate, authorize('ADMIN'), ticketController.updateStatus);

export default router;
