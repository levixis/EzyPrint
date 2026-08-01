import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import type { TicketCategory, TicketStatus } from '@prisma/client';

/**
 * Ticket Service — support ticket system.
 * Aligned with the actual Prisma schema (Ticket requires raisedByType,
 * raisedByName, description etc. as direct fields).
 */

export async function createTicket(
  raisedByUserId: string,
  data: {
    subject: string;
    description: string;
    category: TicketCategory;
    orderId?: string;
    shopId?: string;
  }
) {
  // Get user info for denormalized fields
  const user = await prisma.user.findUnique({
    where: { id: raisedByUserId },
    select: { name: true, email: true, type: true },
  });
  if (!user) throw ApiError.notFound('User not found');

  // Get shop name if shopId provided
  let shopName: string | undefined;
  if (data.shopId) {
    const shop = await prisma.shop.findUnique({ where: { id: data.shopId }, select: { name: true } });
    shopName = shop?.name ?? undefined;
  }

  return prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.create({
      data: {
        raisedBy: raisedByUserId,
        raisedByType: user.type,
        raisedByName: user.name || 'Unknown',
        raisedByEmail: user.email,
        subject: data.subject,
        description: data.description,
        category: data.category,
        relatedOrderId: data.orderId,
        shopId: data.shopId,
        shopName,
        status: 'OPEN',
      },
    });

    // Create the first message
    await tx.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        senderId: raisedByUserId,
        senderName: user.name || 'Unknown',
        senderType: user.type,
        message: data.description,
      },
    });

    // Record status creation
    await tx.ticketStatusChange.create({
      data: {
        ticketId: ticket.id,
        from: 'OPEN',
        to: 'OPEN',
        changedBy: raisedByUserId,
        changedByName: user.name || 'Unknown',
        note: 'Ticket created',
      },
    });

    return ticket;
  });
}

export async function listTickets(
  userId: string,
  userType: string,
  options?: { status?: TicketStatus; page?: number; limit?: number }
) {
  const page = Math.max(1, options?.page || 1);
  const limit = Math.min(50, Math.max(1, options?.limit || 20));

  const where: Record<string, unknown> = {};
  if (userType !== 'ADMIN') where.raisedBy = userId;
  if (options?.status) where.status = options.status;

  const [tickets, total] = await Promise.all([
    prisma.ticket.findMany({
      where,
      include: {
        raiser: { select: { id: true, name: true, email: true } },
        _count: { select: { messages: true } },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.ticket.count({ where }),
  ]);

  return {
    tickets,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getTicketById(ticketId: string, userId: string, userType: string) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      raiser: { select: { id: true, name: true, email: true } },
      messages: {
        include: { sender: { select: { id: true, name: true, type: true } } },
        orderBy: { createdAt: 'asc' },
      },
      statusHistory: { orderBy: { createdAt: 'asc' } },
      attachments: true,
    },
  });

  if (!ticket) throw ApiError.notFound('Ticket not found');
  if (userType !== 'ADMIN' && ticket.raisedBy !== userId) {
    throw ApiError.forbidden('Not your ticket');
  }

  return ticket;
}

export async function addMessage(
  ticketId: string,
  senderUserId: string,
  message: string,
  userType: string
) {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw ApiError.notFound('Ticket not found');
  if (userType !== 'ADMIN' && ticket.raisedBy !== senderUserId) {
    throw ApiError.forbidden('Not your ticket');
  }
  if (ticket.status === 'CLOSED') throw ApiError.badRequest('Ticket is closed');

  // Get sender info for denormalized fields
  const user = await prisma.user.findUnique({
    where: { id: senderUserId },
    select: { name: true, type: true },
  });

  return prisma.ticketMessage.create({
    data: {
      ticketId,
      senderId: senderUserId,
      senderName: user?.name || 'Unknown',
      senderType: user?.type || 'STUDENT',
      message,
    },
    include: { sender: { select: { id: true, name: true, type: true } } },
  });
}

export async function updateTicketStatus(
  ticketId: string,
  newStatus: TicketStatus,
  changedByUserId: string,
  note?: string
) {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw ApiError.notFound('Ticket not found');

  const user = await prisma.user.findUnique({
    where: { id: changedByUserId },
    select: { name: true },
  });

  const [updatedTicket] = await prisma.$transaction([
    prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: newStatus,
        ...(newStatus === 'RESOLVED' ? { updatedAt: new Date() } : {}),
      },
    }),
    prisma.ticketStatusChange.create({
      data: {
        ticketId,
        from: ticket.status,
        to: newStatus,
        changedBy: changedByUserId,
        changedByName: user?.name || 'Unknown',
        note,
      },
    }),
  ]);

  return updatedTicket;
}
