import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import type { NotificationType } from '@prisma/client';
import { env } from '../config/env';

/**
 * Notification Service — in-app notifications for users.
 */

/**
 * Create a notification for a user.
 */
export async function createNotification(
  recipientUserId: string,
  message: string,
  type: NotificationType = 'info',
  metadata?: { orderId?: string; targetShopId?: string }
) {
  return prisma.notification.create({
    data: {
      recipientUserId,
      message,
      type,
      orderId: metadata?.orderId,
      targetShopId: metadata?.targetShopId,
    },
  });
}

/**
 * Get notifications for a user with pagination.
 */
export async function getNotifications(userId: string, options?: {
  page?: number;
  limit?: number;
  unreadOnly?: boolean;
}) {
  const page = Math.max(1, options?.page || 1);
  const limit = Math.min(50, Math.max(1, options?.limit || 20));

  const where: Record<string, unknown> = { recipientUserId: userId };
  if (options?.unreadOnly) where.read = false;

  const [notifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { recipientUserId: userId, read: false } }),
  ]);

  return {
    notifications,
    unreadCount,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Mark a single notification as read.
 */
export async function markAsRead(notificationId: string, userId: string) {
  const notification = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!notification) throw ApiError.notFound('Notification not found');
  if (notification.recipientUserId !== userId) throw ApiError.forbidden('Not your notification');

  return prisma.notification.update({
    where: { id: notificationId },
    data: { read: true },
  });
}

/**
 * Mark all notifications as read for a user.
 */
export async function markAllAsRead(userId: string) {
  const result = await prisma.notification.updateMany({
    where: { recipientUserId: userId, read: false },
    data: { read: true },
  });
  return { markedCount: result.count };
}

/**
 * Delete read notifications past the retention window.
 *
 * This table is written by every `notify.*` call and was deleted from only when
 * a user's account was removed, so it grew monotonically with platform activity
 * and nothing was watching it.
 *
 * Read ones only. An unread notification is something the recipient has not seen
 * yet, and ageing it out silently is worse than keeping the row — the whole
 * point of the record is that it survives until someone looks at it. What is
 * being reclaimed here is the far larger population of notifications that have
 * already done their job; the durable account of what happened lives in the
 * order, ledger entry or ticket each one points at.
 */
export async function sweepReadNotifications(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await prisma.notification.deleteMany({
    where: { read: true, createdAt: { lt: cutoff } },
  });
  return result.count;
}
