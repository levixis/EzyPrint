import { Request, Response, NextFunction } from 'express';
import * as ticketService from '../services/ticket.service';
import { ApiError } from '../utils/ApiError';
import type { TicketStatus } from '@prisma/client';

export async function createTicket(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { subject, description, category, relatedOrderId } = req.body;
    if (!subject || !description || !category) {
      throw ApiError.badRequest('subject, description, and category are required');
    }
    
    let verifiedOrderId = undefined;
    let verifiedShopId = undefined;
    
    if (relatedOrderId) {
      const { prisma } = await import('../utils/prisma');
      const order = await prisma.order.findUnique({ where: { id: relatedOrderId } });
      if (!order) {
        throw ApiError.notFound('Related order not found');
      }
      if (order.userId !== req.user.userId && req.user.userType !== 'ADMIN') {
        throw ApiError.forbidden('You do not own this order');
      }
      verifiedOrderId = order.id;
      verifiedShopId = order.shopId;
    }

    const ticket = await ticketService.createTicket(req.user.userId, {
      subject, description, category, orderId: verifiedOrderId, shopId: verifiedShopId,
    });
    res.status(201).json({ success: true, message: 'Ticket created', data: { ticket } });
  } catch (error) { next(error); }
}

export async function listTickets(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { status, page, limit } = req.query;
    const result = await ticketService.listTickets(req.user.userId, req.user.userType, {
      status: status as TicketStatus | undefined,
      page: page ? parseInt(page as string, 10) : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
}

export async function getTicket(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const ticket = await ticketService.getTicketById(
      req.params.ticketId as string, req.user.userId, req.user.userType
    );
    res.json({ success: true, data: { ticket } });
  } catch (error) { next(error); }
}

export async function addMessage(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { message } = req.body;
    if (!message) throw ApiError.badRequest('message is required');
    const msg = await ticketService.addMessage(
      req.params.ticketId as string, req.user.userId, message, req.user.userType
    );
    res.status(201).json({ success: true, data: { message: msg } });
  } catch (error) { next(error); }
}

export async function updateStatus(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { status, note } = req.body;
    if (!status) throw ApiError.badRequest('status is required');
    const ticket = await ticketService.updateTicketStatus(req.params.ticketId as string, status, req.user.userId, note);
    res.json({ success: true, message: `Ticket ${status}`, data: { ticket } });
  } catch (error) { next(error); }
}
