import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { authorizeChannel, shopIdFromChannel } from '../services/realtime.service';
import { buildBalanceSnapshot } from '../services/ledger.service';

const router = Router();

/**
 * POST /api/v1/realtime/auth
 *
 * Pusher private-channel authorization. Sits behind the same `authenticate`
 * middleware as every other endpoint, so channel access is decided from the
 * verified JWT rather than anything the client asserts.
 *
 * Shop ledger channels carry financial data, so a subscription is granted only
 * to the shop's own owner or an admin. Everything else is refused, including
 * channel names that do not match a shape we recognise.
 */
router.post('/auth', authenticate, async (req, res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();

    const socketId = req.body?.socket_id;
    const channel = req.body?.channel_name;

    if (typeof socketId !== 'string' || typeof channel !== 'string') {
      throw ApiError.badRequest('socket_id and channel_name are required');
    }

    const shopId = shopIdFromChannel(channel);
    if (!shopId) {
      throw ApiError.forbidden('Unknown channel');
    }

    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { ownerUserId: true },
    });
    if (!shop) throw ApiError.forbidden('Unknown channel');

    const isOwner = shop.ownerUserId === req.user.userId;
    const isAdmin = req.user.userType === 'ADMIN';
    if (!isOwner && !isAdmin) {
      throw ApiError.forbidden('You do not have access to this channel');
    }

    res.json(authorizeChannel(socketId, channel));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/realtime/balance/:shopId
 *
 * Authoritative four-stage balance snapshot. The client fetches this on connect
 * and whenever it detects a gap in the event sequence, so a dropped or
 * out-of-order event can never leave a stale number on screen.
 */
router.get('/balance/:shopId', authenticate, async (req, res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const shopId = req.params.shopId as string;

    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        id: true,
        name: true,
        ownerUserId: true,
        pendingBalance: true,
        ledgerBalance: true,
        debtAmount: true,
        lastSettlementAt: true,
        financialVersion: true,
      },
    });

    if (!shop) throw ApiError.notFound('Shop not found');
    if (shop.ownerUserId !== req.user.userId && req.user.userType !== 'ADMIN') {
      throw ApiError.forbidden('Not your shop');
    }

    res.json({ success: true, data: await buildBalanceSnapshot(shop) });
  } catch (error) {
    next(error);
  }
});

export default router;
