import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import type { NotificationType } from '@prisma/client';

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
