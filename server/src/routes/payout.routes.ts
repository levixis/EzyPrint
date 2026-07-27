import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { z } from 'zod';
import * as ledgerService from '../services/ledger.service';
import { ApiError } from '../utils/ApiError';
import type { Request, Response, NextFunction } from 'express';

const router = Router();

// ────────────────────────────────────────────────────────────
// Zod Schemas for payout routes
// ────────────────────────────────────────────────────────────

const ledgerQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    type: z.enum([
      'ORDER_EARNING', 'REFUND_DEDUCTION', 'PAYOUT',
      'MANUAL_PAYOUT_DEDUCTION', 'PAYOUT_CANCEL_REFUND',
      'PAYOUT_REJECT_REFUND', 'CLAWBACK', 'ADJUSTMENT',
    ]).optional(),
  }),
});

// ────────────────────────────────────────────────────────────
// ROUTES
// ────────────────────────────────────────────────────────────

/**
 * GET /api/v1/payouts/ledger/:shopId
 * Get ledger entries for a shop.
 * Shop owner sees their own; admin sees any shop's.
 */
router.get(
  '/ledger/:shopId',
  authenticate,
  authorize('SHOP_OWNER', 'ADMIN'),
  validate(ledgerQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw ApiError.unauthorized();

      const shopId = req.params.shopId as string;
      const { page, limit, type } = req.query;

      // Admin can view any shop's ledger; shop owner must own it
      const ownerUserId = req.user.userType === 'ADMIN'
        ? (await getShopOwnerId(shopId))
        : req.user.userId;

      const result = await ledgerService.getLedgerEntries(shopId, ownerUserId, {
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
        type: type as any,
      });

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/payouts/balance/:shopId
 * Get current balance summary for a shop.
 */
router.get(
  '/balance/:shopId',
  authenticate,
  authorize('SHOP_OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw ApiError.unauthorized();

      const shopId = req.params.shopId as string;
      const balance = await ledgerService.getShopBalance(shopId, req.user.userId, req.user.userType);

      res.json({ success: true, data: { balance } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Helper: get shop owner ID for admin access to any shop's ledger.
 */
async function getShopOwnerId(shopId: string): Promise<string> {
  const { prisma } = await import('../utils/prisma');
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { ownerUserId: true },
  });
  if (!shop) throw ApiError.notFound('Shop not found');
  return shop.ownerUserId;
}

export default router;
