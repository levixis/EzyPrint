import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { validate } from '../middleware/validate';
import { requestRefundSchema, respondRefundSchema, resolveRefundSchema } from '../validators/schemas';
import * as ledgerService from '../services/ledger.service';
import * as realtimeService from '../services/realtime.service';
import * as otpService from '../services/otp.service';
import * as refundService from '../services/refund.service';

const router = Router();

// List refunds for student, shop owner, or admin
router.get('/', authenticate, authorize('ADMIN', 'SHOP_OWNER', 'STUDENT'), async (req, res, next) => {
  try {
    let whereClause: any = {};
    if (req.user?.userType === 'SHOP_OWNER') {
      const shop = await prisma.shop.findUnique({ where: { ownerUserId: req.user.userId } });
      if (!shop) throw ApiError.notFound('Shop not found');
      whereClause = { shopId: shop.id };
    } else if (req.user?.userType === 'STUDENT') {
      whereClause = { studentId: req.user.userId };
    }
    const requests = await prisma.refundRequest.findMany({
      where: whereClause,
      orderBy: { studentRequestedAt: 'desc' },
      include: { order: true }
    });
    res.json({ success: true, data: requests });
  } catch (error) { next(error); }
});

// Student history
router.get('/history/:orderId', authenticate, authorize('STUDENT', 'ADMIN', 'SHOP_OWNER'), async (req, res, next) => {
  try {
    const orderId = req.params.orderId as string;
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw ApiError.notFound('Order not found');
    
    if (req.user?.userType === 'STUDENT' && order.userId !== req.user.userId) throw ApiError.forbidden('Not your order');
    if (req.user?.userType === 'SHOP_OWNER') {
      const shop = await prisma.shop.findUnique({ where: { ownerUserId: req.user.userId } });
      if (shop?.id !== order.shopId) throw ApiError.forbidden('Not your shop order');
    }

    const requests = await prisma.refundRequest.findMany({
      where: { orderId },
      orderBy: { studentRequestedAt: 'desc' }
    });
    res.json({ success: true, count: requests.length, refunds: requests });
  } catch (error) { next(error); }
});

// Create refund
router.post('/', authenticate, authorize('STUDENT'), validate(requestRefundSchema), async (req, res, next) => {
  try {
    const { orderId, reason } = req.body;
    if (!req.user) throw ApiError.unauthorized();
    
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw ApiError.notFound('Order not found');
    if (order.userId !== req.user.userId) throw ApiError.forbidden('Not your order');
    if (order.status === 'PENDING_PAYMENT') throw ApiError.badRequest('Order is unpaid, cannot refund');
    
    const request = await prisma.refundRequest.create({
      data: { orderId, studentId: req.user.userId, shopId: order.shopId, reason, status: 'PENDING_SHOP' }
    });
    
    res.json({ success: true, data: request });
  } catch (error) { next(error); }
});

// Shop owner responds
router.post('/:id/respond', authenticate, authorize('SHOP_OWNER'), validate(respondRefundSchema), async (req, res, next) => {
  try {
    const { approved, shopResponse } = req.body;
    if (!req.user) throw ApiError.unauthorized();

    const shop = await prisma.shop.findUnique({ where: { ownerUserId: req.user.userId } });
    if (!shop) throw ApiError.notFound('Shop not found');

    const status = approved ? 'APPROVED_BY_SHOP' : 'REJECTED_BY_SHOP';

    const updated = await prisma.refundRequest.updateMany({
      where: { id: req.params.id as string, shopId: shop.id, status: 'PENDING_SHOP' },
      data: { status, shopResponse, shopRespondedAt: new Date() }
    });

    if (updated.count === 0) throw ApiError.badRequest('Refund request not found or not in PENDING_SHOP state');
    
    const request = await prisma.refundRequest.findUnique({ where: { id: req.params.id as string } });
    res.json({ success: true, data: request });
  } catch (error) { next(error); }
});

// Student escalates
router.post('/:id/escalate', authenticate, authorize('STUDENT'), async (req, res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();

    const updated = await prisma.refundRequest.updateMany({
      where: { id: req.params.id as string, studentId: req.user.userId, status: 'REJECTED_BY_SHOP' },
      data: { status: 'ESCALATED_TO_ADMIN' }
    });

    if (updated.count === 0) throw ApiError.badRequest('Refund request not found or cannot be escalated');
    
    const request = await prisma.refundRequest.findUnique({ where: { id: req.params.id as string } });
    res.json({ success: true, data: request });
  } catch (error) { next(error); }
});

// Admin resolves
router.post('/:id/resolve', authenticate, authorize('ADMIN'), validate(resolveRefundSchema), async (req, res, next) => {
  try {
    const { action, adminNote, refundAmount, otp } = req.body; // action: 'APPROVE' | 'DENY'
    const id = req.params.id as string;
    if (!req.user) throw ApiError.unauthorized();

    // Step-up verification, scoped to this refund request. Both branches move
    // money or close out a student's claim.
    await otpService.consumeOtp(req.user.userId, `refund_${id}`, otp);
    
    if (action === 'DENY') {
      const updated = await prisma.refundRequest.updateMany({
        where: { id, status: { in: ['ESCALATED_TO_ADMIN', 'APPROVED_BY_SHOP', 'AUTO_ESCALATED'] } },
        data: { status: 'RESOLVED_DENIED', adminNote, resolvedBy: req.user?.userId, adminResolvedAt: new Date() }
      });
      if (updated.count === 0) throw ApiError.badRequest('Refund request not found or invalid state');
      return res.json({ success: true, data: await prisma.refundRequest.findUnique({ where: { id } }) });
    }

    // APPROVE flow -> Segregated transaction
    const initialRequest = await prisma.refundRequest.findUnique({ where: { id }, include: { order: true } });
    if (!initialRequest) throw ApiError.notFound();
    
    const requestedAmount = refundAmount || initialRequest.order.totalPrice;
    if (requestedAmount > initialRequest.order.totalPrice) {
      throw ApiError.badRequest('Refund cannot exceed order total');
    }
    
    if (initialRequest.status === 'PROCESSING_REFUND' && initialRequest.refundAmount && initialRequest.refundAmount !== requestedAmount) {
      throw ApiError.badRequest('Cannot change refund amount for a request that is already processing');
    }

    // 1. Claim
    const claim = await prisma.refundRequest.updateMany({
      where: { id, status: { in: ['ESCALATED_TO_ADMIN', 'APPROVED_BY_SHOP', 'AUTO_ESCALATED', 'PROCESSING_REFUND'] } },
      data: { status: 'PROCESSING_REFUND', refundAmount: requestedAmount, adminNote: adminNote || initialRequest.adminNote }
    });
    if (claim.count === 0) throw ApiError.badRequest('Refund request not found or invalid state');

    // 2 & 3. Network call, then persist. Shared with the automatic refund a
    // cancellation triggers, so both paths agree on who absorbs what.
    await refundService.settleClaimedRefund(id, {
      setOrderRefunded: true,
      createdBy: 'ADMIN',
      adminNote,
      resolvedBy: req.user.userId,
    });

    const result = await prisma.refundRequest.findUnique({ where: { id } });

    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

export default router;
