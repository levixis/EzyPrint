import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { validate } from '../middleware/validate';
import { requestRefundSchema, respondRefundSchema, resolveRefundSchema, shopRefundSchema } from '../validators/schemas';
import { sensitiveLimiter } from '../middleware/rateLimiter';
import { clampListLimit } from '../utils/pagination';
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
    // Clamped like every other list endpoint. This one was unbounded, and for
    // an admin the where clause is empty — so it read every refund request in
    // the system, each with its full order joined on. That is the same defect
    // the payout listing was fixed for, in the sibling that was missed: it
    // grows with the platform, and the first time it matters is the day it is
    // slowest to notice.
    const limit = clampListLimit(req.query.limit);
    // `take` bounds the page size; without `skip` it always returned the first
    // page, so anything older than `limit` was unreachable through the API.
    const page = Math.max(1, Number(req.query.page) || 1);

    const requests = await prisma.refundRequest.findMany({
      where: whereClause,
      orderBy: { studentRequestedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
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
router.post('/', authenticate, authorize('STUDENT'), sensitiveLimiter, validate(requestRefundSchema), async (req, res, next) => {
  try {
    const { orderId, reason } = req.body;
    if (!req.user) throw ApiError.unauthorized();

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw ApiError.notFound('Order not found');
    if (order.userId !== req.user.userId) throw ApiError.forbidden('Not your order');
    if (order.status === 'PENDING_PAYMENT') throw ApiError.badRequest('Order is unpaid, cannot refund');
    if (order.status === 'PAYMENT_FAILED') throw ApiError.badRequest('Nothing was charged for this order');
    if (order.status === 'REFUNDED') throw ApiError.badRequest('This order has already been refunded');

    // `orderId` is unique on RefundRequest, so a second claim is a constraint
    // violation rather than a second row. Returning the existing claim makes a
    // double-tap idempotent instead of a 500, and stops a student raising a
    // fresh claim against an order that was auto-refunded by a cancellation —
    // which would reopen a dispute and pin the order's files indefinitely.
    const existing = await prisma.refundRequest.findUnique({ where: { orderId } });
    if (existing) {
      return res.json({
        success: true,
        data: existing,
        message: 'You have already raised a refund request for this order.',
      });
    }

    const request = await prisma.refundRequest.create({
      data: { orderId, studentId: req.user.userId, shopId: order.shopId, reason, status: 'PENDING_SHOP' }
    });

    res.json({ success: true, data: request });
  } catch (error) { next(error); }
});

/**
 * Shop refunds one of its own orders, without waiting on an admin.
 *
 * A refund returns money to the payer's original card or UPI, so approving one
 * cannot enrich whoever approved it — unlike a payout, which moves money to an
 * account the shop controls and keeps its OTP gate. The service bounds this by
 * velocity instead: a ceiling per refund and per day, over which the claim is
 * left for an admin rather than refused.
 */
router.post('/shop-refund', authenticate, authorize('SHOP_OWNER'), sensitiveLimiter, validate(shopRefundSchema), async (req, res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { orderId, reason } = req.body;

    const outcome = await refundService.shopRefundOrder({
      orderId,
      shopOwnerUserId: req.user.userId,
      reason,
    });

    res.json({
      success: true,
      data: outcome,
      message: outcome.settled
        ? 'Refund issued. The student will see it in 5-7 working days.'
        : `${outcome.escalationReason}. Sent to an admin to process.`,
    });
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

    // Everything the server can refuse on its own is checked before the code is
    // spent — the same ordering `/payouts/:id/cancel` and `/mark-paid` already
    // use. `consumeOtp` deletes the code atomically and has no rollback, so
    // consuming first meant a resolve the server was never going to allow still
    // destroyed the OTP: every retry needed a fresh email and failed
    // identically, which reads as "OTP not working" rather than "another admin
    // already resolved this". At five codes per fifteen minutes, a confused
    // operator locks themselves out of the OTP channel in under a minute —
    // during a refund incident, which is when this route gets used.
    const initialRequest = await prisma.refundRequest.findUnique({ where: { id }, include: { order: true } });
    if (!initialRequest) throw ApiError.notFound('Refund request not found');

    // Shared with the service rather than written out here. The inline copy is
    // exactly what drifted last time: `REFUND_FAILED` was added to the shop's
    // list and missed in this one, so the retry every other part of the
    // codebase promises answered "invalid state".
    const admissible = action === 'DENY'
      ? refundService.ADMIN_ACTIONABLE_STATUSES
      : refundService.ADMIN_APPROVABLE_STATUSES;

    if (!admissible.includes(initialRequest.status)) {
      throw ApiError.badRequest(
        `This refund is ${initialRequest.status.toLowerCase().replace(/_/g, ' ')} and cannot be ` +
        `${action === 'DENY' ? 'denied' : 'approved'}.`
      );
    }

    const requestedAmount = refundAmount || initialRequest.order.totalPrice;
    if (action === 'APPROVE') {
      if (requestedAmount > initialRequest.order.totalPrice) {
        throw ApiError.badRequest('Refund cannot exceed order total');
      }
      if (initialRequest.status === 'PROCESSING_REFUND' && initialRequest.refundAmount && initialRequest.refundAmount !== requestedAmount) {
        throw ApiError.badRequest('Cannot change refund amount for a request that is already processing');
      }
    }

    // Step-up verification, scoped to this refund request. Both branches move
    // money or close out a student's claim.
    await otpService.consumeOtp(req.user.userId, `refund_${id}`, otp);

    if (action === 'DENY') {
      const updated = await prisma.refundRequest.updateMany({
        // Still guarded, despite the check above: that read is outside any
        // transaction, so a second admin resolving in the meantime must lose
        // the race rather than have their decision silently overwritten.
        where: { id, status: { in: refundService.ADMIN_ACTIONABLE_STATUSES } },
        data: { status: 'RESOLVED_DENIED', adminNote, resolvedBy: req.user?.userId, adminResolvedAt: new Date() }
      });
      if (updated.count === 0) throw ApiError.badRequest('Refund request not found or invalid state');
      return res.json({ success: true, data: await prisma.refundRequest.findUnique({ where: { id } }) });
    }

    // 1. Claim
    const claim = await prisma.refundRequest.updateMany({
      // Approvable = actionable, plus a refund already in flight that has
      // stalled. Shared with the service so this list and the shop's cannot
      // drift apart again.
      where: { id, status: { in: refundService.ADMIN_APPROVABLE_STATUSES } },
      data: {
        status: 'PROCESSING_REFUND',
        refundAmount: requestedAmount,
        adminNote: adminNote || initialRequest.adminNote,
        // Stamped here rather than only in `settleClaimedRefund`, for the same
        // reason as the shop path: this column is what the shop's daily refund
        // velocity cap counts, and a row that is in flight but unstamped is
        // invisible to it for the length of a gateway round trip.
        adminResolvedAt: new Date(),
      }
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
