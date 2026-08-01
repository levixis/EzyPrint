import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { resolveReactivationSchema } from '../validators/schemas';
import * as otpService from '../services/otp.service';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';

const router = Router();

router.get('/', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const requests = await prisma.reactivationRequest.findMany({
      orderBy: { requestedAt: 'desc' }
    });
    res.json({ success: true, reactivationRequests: requests, data: requests });
  } catch (error) {
    next(error);
  }
});

router.post('/submit', authenticate, authorize('SHOP_OWNER'), async (req, res, next) => {
  try {
    const { shopId, shopName } = req.body;
    if (!req.user) throw ApiError.unauthorized();
    
    const existing = await prisma.reactivationRequest.findFirst({
      where: { shopId, status: 'pending' }
    });
    
    if (existing) {
      return res.json({ success: false, message: 'Request already pending.' });
    }
    
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    
    await prisma.reactivationRequest.create({
      data: {
        shopId,
        shopName,
        ownerUid: req.user.userId,
        ownerEmail: req.user.email || '',
        ownerName: user?.name || 'Shop Owner',
        status: 'pending'
      }
    });
    
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/resolve', authenticate, authorize('ADMIN'), validate(resolveReactivationSchema), async (req, res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { action, otp, rejectionReason } = req.body;
    const requestId = req.params.id as string;

    await otpService.consumeOtp(req.user.userId, `reactivation_${requestId}`, otp);

    const status = action === 'approve' ? 'approved' : 'rejected';

    await prisma.$transaction(async (tx) => {
      // Guarded on `pending` so two admins resolving at once cannot both apply,
      // which would otherwise let a rejection silently overwrite an approval.
      const claimed = await tx.reactivationRequest.updateMany({
        where: { id: requestId, status: 'pending' },
        data: {
          status,
          rejectionReason,
          resolvedBy: req.user?.userId,
          resolvedAt: new Date()
        }
      });
      if (claimed.count === 0) {
        throw ApiError.badRequest('This request has already been resolved.');
      }

      const request = await tx.reactivationRequest.findUnique({ where: { id: requestId } });
      if (!request) throw ApiError.notFound('Reactivation request not found');

      if (status === 'approved') {
        await tx.shop.update({
          where: { id: request.shopId },
          data: { isArchived: false, isOpen: true }
        });
      }
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
