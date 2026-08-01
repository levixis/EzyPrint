import { Request, Response, NextFunction } from 'express';
import * as referralService from '../services/referral.service';
import { ApiError } from '../utils/ApiError';

export async function createReferralCode(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user || req.user.userType !== 'ADMIN') throw ApiError.forbidden();
    const { daysValid } = req.body;
    const code = await referralService.createReferralCode(req.user.userId, daysValid);
    res.json({ success: true, data: { code } });
  } catch (error) {
    next(error);
  }
}

export async function listReferralCodes(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user || req.user.userType !== 'ADMIN') throw ApiError.forbidden();
    const codes = await referralService.listReferralCodes();
    res.json({ success: true, data: { codes } });
  } catch (error) {
    next(error);
  }
}

export async function deleteReferralCode(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user || req.user.userType !== 'ADMIN') throw ApiError.forbidden();
    const { codeId } = req.params;
    await referralService.deleteReferralCode(codeId as string);
    res.json({ success: true, message: 'Referral code deleted' });
  } catch (error) {
    next(error);
  }
}
