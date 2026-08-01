import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { createTicketSchema, ticketMessageSchema, ticketStatusSchema } from '../validators/schemas';
import * as ticketController from '../controllers/ticket.controller';

const router = Router();

router.post('/', authenticate, validate(createTicketSchema), ticketController.createTicket);
router.get('/', authenticate, ticketController.listTickets);
router.get('/:ticketId', authenticate, ticketController.getTicket);
router.post('/:ticketId/messages', authenticate, validate(ticketMessageSchema), ticketController.addMessage);
router.patch('/:ticketId/status', authenticate, authorize('ADMIN'), validate(ticketStatusSchema), ticketController.updateStatus);

export default router;
