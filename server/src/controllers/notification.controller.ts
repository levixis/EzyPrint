import { Request, Response, NextFunction } from 'express';
import * as notifService from '../services/notification.service';
import { ApiError } from '../utils/ApiError';

export async function getNotifications(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { page, limit, unreadOnly } = req.query;
    const result = await notifService.getNotifications(req.user.userId, {
      page: page ? parseInt(page as string, 10) : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      unreadOnly: unreadOnly === 'true',
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
}

export async function markAsRead(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const notification = await notifService.markAsRead(req.params.notificationId, req.user.userId);
    res.json({ success: true, data: { notification } });
  } catch (error) { next(error); }
}

export async function markAllAsRead(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const result = await notifService.markAllAsRead(req.user.userId);
    res.json({ success: true, message: `${result.markedCount} notifications marked as read` });
  } catch (error) { next(error); }
}
