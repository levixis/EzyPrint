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

    // A shop owner may only ever request reactivation for their own shop. The
    // route authorises the *role*, not the *shop*, so without this any shop
    // owner could file a request against somebody else's — and an admin
    // approving it would reinstate a shop its owner never asked to reinstate.
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { ownerUserId: true, name: true },
    });
    if (!shop) throw ApiError.notFound('Shop not found');
    if (shop.ownerUserId !== req.user.userId) throw ApiError.forbidden('Not your shop');

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });

    // Attempt the write and let the database arbitrate, rather than reading
    // first and creating second. Nothing stood between those two statements, so
    // two taps on "Request Reactivation" — which is what a locked-out owner
    // does when the first appears to do nothing — produced two pending rows.
    // The admin saw the request twice, approved one, and the other stayed
    // pending forever against a shop that was already active again.
    //
    // The partial unique index added in migration
    // 20260802200000_one_pending_reactivation_per_shop is what makes this
    // race-free; the catch below only turns its error into the same friendly
    // answer the check used to give.
    try {
      await prisma.reactivationRequest.create({
        data: {
          shopId,
          // Taken from the shop rather than the request body, which the client
          // supplies and could disagree with the row an admin is about to act on.
          shopName: shop.name || shopName,
          ownerUid: req.user.userId,
          ownerEmail: req.user.email || '',
          ownerName: user?.name || 'Shop Owner',
          status: 'pending'
        }
      });
    } catch (error) {
      // P2002 — unique constraint. Someone (quite possibly this same person a
      // moment ago) already has a request open for this shop, which is the
      // outcome the owner wanted anyway.
      if ((error as { code?: string }).code === 'P2002') {
        return res.json({ success: false, message: 'Request already pending.' });
      }
      throw error;
    }

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
