import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createTicketSchema, ticketMessageSchema, ticketStatusSchema } from '../validators/schemas';
import * as ticketController from '../controllers/ticket.controller';

const router = Router();

router.post('/', authenticate, validate(createTicketSchema), ticketController.createTicket);
router.get('/', authenticate, ticketController.listTickets);
router.get('/:ticketId', authenticate, ticketController.getTicket);
router.post('/:ticketId/messages', authenticate, validate(ticketMessageSchema), ticketController.addMessage);
// Not ADMIN-only: a shop must be able to resolve a complaint it has settled,
// and a student to escalate or close their own. Who may set which status is
// decided per-ticket in the service, since it depends on the caller's relation
// to that ticket rather than on their role alone.
router.patch('/:ticketId/status', authenticate, validate(ticketStatusSchema), ticketController.updateStatus);

export default router;
