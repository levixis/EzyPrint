import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import type { TicketCategory, TicketStatus } from '@prisma/client';
import { purgeTicketAttachments } from './cleanup.service';
import * as notify from './notify.service';

/**
 * Ticket Service — support ticket system.
 * Aligned with the actual Prisma schema (Ticket requires raisedByType,
 * raisedByName, description etc. as direct fields).
 */

/** The shop a given owner runs, or null if they have none yet. */
async function shopIdForOwner(ownerUserId: string): Promise<string | null> {
  const shop = await prisma.shop.findUnique({
    where: { ownerUserId },
    select: { id: true },
  });
  return shop?.id ?? null;
}

/**
 * Whether a user may read and reply to a ticket.
 *
 * Three parties can be involved: the raiser, an admin, and — when the ticket
 * is filed against a shop — that shop's owner. The upload controller's
 * `verifyStorageAccess` already granted shop owners access to ticket
 * attachments, so excluding them here left them able to fetch a complaint's
 * files while being unable to read the complaint.
 */
async function canAccessTicket(
  ticket: { raisedBy: string; shopId: string | null },
  userId: string,
  userType: string
): Promise<boolean> {
  if (userType === 'ADMIN') return true;
  if (ticket.raisedBy === userId) return true;
  if (userType === 'SHOP_OWNER' && ticket.shopId) {
    return ticket.shopId === (await shopIdForOwner(userId));
  }
  return false;
}

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

  const ticket = await prisma.$transaction(async (tx) => {
    const created = await tx.ticket.create({
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
        ticketId: created.id,
        senderId: raisedByUserId,
        senderName: user.name || 'Unknown',
        senderType: user.type,
        message: data.description,
      },
    });

    // Record status creation
    await tx.ticketStatusChange.create({
      data: {
        ticketId: created.id,
        from: 'OPEN',
        to: 'OPEN',
        changedBy: raisedByUserId,
        changedByName: user.name || 'Unknown',
        note: 'Ticket created',
      },
    });

    return created;
  });

  // After commit — the support desk should never be paged about a ticket whose
  // transaction rolled back.
  notify.notifyTicketCreated({
    id: ticket.id,
    subject: ticket.subject,
    raisedBy: ticket.raisedBy,
    raisedByName: ticket.raisedByName,
    shopId: ticket.shopId,
  });

  return ticket;
}

export async function listTickets(
  userId: string,
  userType: string,
  options?: { status?: TicketStatus; page?: number; limit?: number }
) {
  const page = Math.max(1, options?.page || 1);
  const limit = Math.min(50, Math.max(1, options?.limit || 20));

  const where: Record<string, unknown> = {};

  if (userType === 'SHOP_OWNER') {
    // A shop owner is a party to two different sets of tickets: the ones they
    // raised themselves, and the customer complaints filed against their shop.
    // Scoping to `raisedBy` alone hid the second set entirely, which is the
    // set the shop dashboard's "Customer tickets about your orders" panel
    // exists to show.
    const shopId = await shopIdForOwner(userId);
    where.OR = shopId
      ? [{ raisedBy: userId }, { shopId }]
      : [{ raisedBy: userId }];
  } else if (userType !== 'ADMIN') {
    where.raisedBy = userId;
  }

  if (options?.status) where.status = options.status;

  const [tickets, total] = await Promise.all([
    prisma.ticket.findMany({
      where,
      include: {
        raiser: { select: { id: true, name: true, email: true } },
        // The thread ships with the list because nothing ever fetches a ticket
        // by id — TicketDetail renders straight from this data. Sending only a
        // count meant the conversation was always empty and reading
        // `messages.length` threw, blanking the page. Support ticket volume is
        // low enough that this is cheaper than a second round trip per ticket.
        messages: {
          include: { sender: { select: { id: true, name: true, type: true } } },
          orderBy: { createdAt: 'asc' },
        },
        attachments: true,
        statusHistory: { orderBy: { createdAt: 'asc' } },
        _count: { select: { messages: true } },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.ticket.count({ where }),
  ]);

  return {
    // `_count` is Prisma's shape, not the client's. Flattening it here keeps
    // the wire format the frontend's SupportTicket type actually describes.
    tickets: tickets.map(({ _count, ...ticket }) => ({
      ...ticket,
      messageCount: _count.messages,
    })),
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
  if (!(await canAccessTicket(ticket, userId, userType))) {
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
  if (!(await canAccessTicket(ticket, senderUserId, userType))) {
    throw ApiError.forbidden('Not your ticket');
  }
  if (ticket.status === 'CLOSED') throw ApiError.badRequest('Ticket is closed');

  // Get sender info for denormalized fields
  const user = await prisma.user.findUnique({
    where: { id: senderUserId },
    select: { name: true, type: true },
  });

  // Which party replied last. The schema has carried these three columns since
  // the beginning and nothing ever wrote them, so response-time reporting had
  // no data to work from.
  const repliedAt = new Date();
  const replyStamp =
    userType === 'ADMIN' ? { adminLastRepliedAt: repliedAt }
    : ticket.raisedBy === senderUserId ? { raiserLastRepliedAt: repliedAt }
    : { shopLastRepliedAt: repliedAt };

  const [created] = await prisma.$transaction([
    prisma.ticketMessage.create({
      data: {
        ticketId,
        senderId: senderUserId,
        senderName: user?.name || 'Unknown',
        senderType: user?.type || 'STUDENT',
        message,
      },
      include: { sender: { select: { id: true, name: true, type: true } } },
    }),
    prisma.ticket.update({ where: { id: ticketId }, data: replyStamp }),
  ]);

  // Everyone on the thread except whoever just typed.
  notify.notifyTicketReply({
    ticketId,
    subject: ticket.subject,
    raisedBy: ticket.raisedBy,
    shopId: ticket.shopId,
    senderId: senderUserId,
    senderName: user?.name || 'Someone',
  });

  return created;
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

  notify.notifyTicketStatus({
    ticketId,
    subject: ticket.subject,
    raisedBy: ticket.raisedBy,
    shopId: ticket.shopId,
    newStatus,
    actorUserId: changedByUserId,
  });

  // The dispute is over, so the evidence attached to it can go. The
  // conversation stays — that is the record of what was decided. Fired after
  // the commit so a storage failure cannot undo the resolution; the sweep
  // retries anything left behind.
  if (newStatus === 'RESOLVED' || newStatus === 'CLOSED') {
    purgeTicketAttachments(ticketId).catch((error) => {
      console.error(`[ticket] attachment cleanup failed for ${ticketId}, leaving it to the sweep:`, error);
    });
  }

  return updatedTicket;
}
