import { Request, Response, NextFunction } from 'express';
import * as userService from '../services/user.service';
import * as pushService from '../services/push.service';
import { ApiError } from '../utils/ApiError';
import type { UserType } from '@prisma/client';

export async function getProfile(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const user = await userService.getUserById(req.user.userId);
    res.json({ success: true, data: { user } });
  } catch (error) { next(error); }
}

export async function updateProfile(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { name, phone, preferredLanguage, profilePhotoUrl } = req.body;
    const user = await userService.updateUserProfile(req.user.userId, {
      name, phone, preferredLanguage, profilePhotoUrl,
    });
    res.json({ success: true, data: { user } });
  } catch (error) { next(error); }
}

/**
 * Store the device's FCM token against the signed-in user.
 *
 * The client has been posting here since push was first added; until now there
 * was no route to receive it, so every token was dropped on a swallowed 404 and
 * no device could ever be reached.
 */
export async function registerPushToken(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    await pushService.addPushToken(req.user.userId, req.body.token);
    res.json({ success: true, message: 'Push token registered' });
  } catch (error) { next(error); }
}

/** Drop the device's token on logout, so the next user of this phone is not
 *  sent the previous one's order and ticket updates. */
export async function unregisterPushToken(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    await pushService.removePushToken(req.user.userId, req.body.token);
    res.json({ success: true, message: 'Push token removed' });
  } catch (error) { next(error); }
}

export async function listUsers(req: Request, res: Response, next: NextFunction) {
  try {
    const { page, limit, type, search, hasPass } = req.query;
    const result = await userService.listUsers({
      page: page ? parseInt(page as string, 10) : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      type: type as UserType | undefined,
      search: search as string,
      hasPass: hasPass === 'true' ? true : hasPass === 'false' ? false : undefined,
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
}

