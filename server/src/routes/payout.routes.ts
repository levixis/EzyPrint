import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { z } from 'zod';
import * as ledgerService from '../services/ledger.service';
import { ApiError } from '../utils/ApiError';
import type { Request, Response, NextFunction } from 'express';
import { requestPayoutSchema, otpGuardedSchema, manualPayoutWithOtpSchema } from '../validators/schemas';
import * as otpService from '../services/otp.service';
import * as realtimeService from '../services/realtime.service';
import * as notifyService from '../services/notify.service';
import { sensitiveLimiter } from '../middleware/rateLimiter';
import { prisma } from '../utils/prisma';
import type { Prisma, PayoutStatus } from '@prisma/client';

/**
 * Tell a shop about a payout change it did not make itself.
 *
 * Every one of these paths used to end silently: a shop requested a payout and
 * no admin heard, an admin approved or rejected one and the shop found out by
 * refreshing. `notifyPayoutUpdate` and `notifyAdmins` both existed and neither
 * was called from here.
 *
 * Fire-and-forget on purpose — the notification helpers swallow their own
 * failures, and a push provider having a bad minute must not fail a request
 * that has already moved money.
 */
async function tellShop(
  shopId: string,
  message: string,
  type: 'info' | 'success' | 'warning' | 'error' = 'info',
  /**
   * Subject line for an email copy. Set on admin decisions only.
   *
   * Every current caller is an admin acting on someone else's money, so all of
   * them pass one. It stays a parameter rather than becoming the default
   * because the shop-driven routes — request, dispute, confirm — must not mail
   * a shop about a button it just pressed itself.
   */
  emailSubject?: string
) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { ownerUserId: true } });
  if (!shop) return;
  notifyService.notifyPayoutUpdate({ shopId, ownerUserId: shop.ownerUserId, message, type, emailSubject });
}

const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

/**
 * Payout states a cancellation may act on.
 *
 * PENDING — the shop or an admin changing their mind before approval.
 * DISPUTED — the shop has reported the money never arrived, and returning the
 *   reservation to their balance is the resolution the admin dashboard offers
 *   on that row. Only PENDING was allowed, so that button always failed.
 *
 * Deliberately excludes IN_TRANSIT and PAID: money has left, or is said to
 * have left, and crediting the balance back while it is in flight would pay
 * the shop twice.
 */
const CANCELLABLE_PAYOUT_STATUSES: PayoutStatus[] = ['PENDING', 'DISPUTED'];

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
    } catch (error) { next(error); }
  }
);

/**
 * Queue a `payout.updated` event for a shop, from inside the transaction that
 * changes the payout's status.
 *
 * Enqueuing here rather than after the commit is what makes the notification
 * inseparable from the state change: if the transaction rolls back the outbox
 * row goes with it, and if it commits the dispatcher will deliver even when
 * Pusher is unreachable at this instant.
 *
 * `seq` carries the shop's current `financialVersion` *without* incrementing
 * it. A payout status change moves no money — the balance already moved when
 * the reservation was written at request time — so claiming a new balance
 * sequence number would make the client see a gap where a ledger event went
 * missing and trigger a pointless snapshot refetch. Reading the value needs no
 * compare-and-swap precisely because nothing is written back.
 */
async function enqueuePayoutEvent(
  tx: Prisma.TransactionClient,
  shopId: string,
  data: { payoutId: string; status: string; amount: number }
): Promise<string> {
  const shop = await tx.shop.findUnique({
    where: { id: shopId },
    select: { financialVersion: true },
  });

  return realtimeService.enqueueShopEvent(tx, {
    shopId,
    type: 'payout.updated',
    seq: shop?.financialVersion ?? 0,
    data,
  });
}

async function getShopOwnerId(shopId: string): Promise<string> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { ownerUserId: true },
  });
  if (!shop) throw ApiError.notFound('Shop not found');
  return shop.ownerUserId;
}

// Basic CRUD for payouts
router.get('/', authenticate, authorize('ADMIN', 'SHOP_OWNER'), async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 20;
    const shopId = req.query.shopId as string;
    
    const whereClause: any = {};
    if (req.user?.userType === 'SHOP_OWNER') {
      const shop = await prisma.shop.findUnique({ where: { ownerUserId: req.user.userId } });
      whereClause.shopId = shop?.id;
    } else if (shopId) {
      whereClause.shopId = shopId;
    }

    const payouts = await prisma.payout.findMany({
      where: whereClause,
      take: limit,
      orderBy: { createdAt: 'desc' }
    });
    
    res.json({ success: true, data: payouts });
  } catch (error) { next(error); }
});

router.post('/request', authenticate, authorize('SHOP_OWNER'), validate(requestPayoutSchema), async (req, res, next) => {
  try {
    const { amount, shopOwnerNote } = req.body;
    const shop = await prisma.shop.findUnique({ where: { ownerUserId: req.user?.userId } });
    if (!shop) throw ApiError.notFound('Shop not found');
    
    const outboxIds: string[] = [];

    const result = await prisma.$transaction(async (tx) => {
      const payout = await tx.payout.create({
        data: { shopId: shop.id, shopName: shop.name, amount: Number(amount), shopOwnerNote, status: 'PENDING' }
      });
      
      await ledgerService.createLedgerEntry({
        shopId: shop.id,
        type: 'PAYOUT',
        amount: Number(amount),
        description: 'Payout request reservation',
        counterparty: 'PLATFORM',
        createdBy: 'SHOP',
        eventId: `payout:${payout.id}:reservation`
      }, tx, outboxIds);

      return payout;
    });

    await realtimeService.publishQueued(outboxIds);

    notifyService.notifyAdmins(
      `${shop.name} requested a payout of ${rupees(Number(amount))}.`,
      'warning'
    );

    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.post('/:id/approve', authenticate, authorize('ADMIN'), sensitiveLimiter, validate(otpGuardedSchema), async (req, res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { adminNote, otp } = req.body;
    const payoutId = req.params.id as string;

    // Step-up verification. Approving a payout moves real money, so it must not
    // rest on session auth alone.
    await otpService.consumeOtp(req.user.userId, `payout_${payoutId}`, otp);

    const outboxIds: string[] = [];

    const result = await prisma.$transaction(async (tx) => {
      // Approving and sending are one act here. The separate IN_TRANSIT step
      // existed for an operation that authorises a batch in the morning and
      // makes the transfers in the afternoon; a single admin sending UPI has no
      // gap between the two, so the second step only asked them to re-assert
      // something already true — and cost another OTP to do it.
      //
      // PAID means "we have sent this", which is the last thing an admin can
      // truthfully claim. Whether it arrived is the shop's to say, and that is
      // what CONFIRMED and DISPUTED are for.
      const updated = await tx.payout.updateMany({
        where: { id: payoutId, status: 'PENDING' },
        data: { status: 'PAID', paidAt: new Date(), adminNote },
      });
      if (updated.count === 0) throw ApiError.badRequest('Payout not found or invalid state');

      const payout = await tx.payout.findUnique({ where: { id: payoutId } });
      if (!payout) throw ApiError.notFound('Payout not found');

      const entryUpdate = await tx.ledgerEntry.updateMany({
        where: { eventId: `payout:${payout.id}:reservation`, status: 'PENDING' },
        data: { status: 'SETTLED', settledAt: new Date() },
      });
      // Without this check the payout could be marked approved while the ledger
      // recorded nothing — money out the door with no corresponding entry.
      if (entryUpdate.count === 0) {
        throw ApiError.badRequest('Reservation ledger entry not found or already settled');
      }

      outboxIds.push(await enqueuePayoutEvent(tx, payout.shopId, {
        payoutId: payout.id,
        status: 'PAID',
        amount: payout.amount,
      }));

      return payout;
    });

    await realtimeService.publishQueued(outboxIds);

    await tellShop(result.shopId, `Your payout of ${rupees(result.amount)} was approved and is on its way.`, 'success', 'Your EzyPrint payout has been sent');

    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

/**
 * Admin marks an in-transit payout as landed in the shop's bank account.
 */
router.post('/:id/mark-paid', authenticate, authorize('ADMIN'), sensitiveLimiter, validate(otpGuardedSchema), async (req, res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { adminNote, otp } = req.body;
    const payoutId = req.params.id as string;

    await otpService.consumeOtp(req.user.userId, `payout_${payoutId}`, otp);

    const outboxIds: string[] = [];

    const result = await prisma.$transaction(async (tx) => {
      // IN_TRANSIT in the where clause is the state guard: two admins marking
      // the same payout paid means the second updateMany matches nothing and
      // fails, rather than stamping a second paidAt over the first.
      const updated = await tx.payout.updateMany({
        where: { id: payoutId, status: 'IN_TRANSIT' },
        data: { status: 'PAID', paidAt: new Date(), ...(adminNote ? { adminNote } : {}) },
      });
      if (updated.count === 0) throw ApiError.badRequest('Payout is not in transit');

      const payout = await tx.payout.findUnique({ where: { id: payoutId } });
      if (!payout) throw ApiError.notFound('Payout not found');

      outboxIds.push(await enqueuePayoutEvent(tx, payout.shopId, {
        payoutId: payout.id,
        status: 'PAID',
        amount: payout.amount,
      }));

      return payout;
    });

    await realtimeService.publishQueued(outboxIds);

    await tellShop(result.shopId, `${rupees(result.amount)} has been sent to your bank account.`, 'success', 'Your EzyPrint payout has been sent');

    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.post('/:id/reject', authenticate, authorize('ADMIN'), sensitiveLimiter, validate(otpGuardedSchema), async (req, res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { adminNote, otp } = req.body;

    await otpService.consumeOtp(req.user.userId, `payout_${req.params.id}`, otp);

    const outboxIds: string[] = [];

    const result = await prisma.$transaction(async (tx) => {
      const payout = await tx.payout.findUnique({ where: { id: req.params.id as string } });
      if (!payout) throw ApiError.notFound('Payout not found');
      
      const updated = await tx.payout.updateMany({
        where: { id: payout.id, status: 'PENDING' },
        data: { status: 'REJECTED', adminNote }
      });
      if (updated.count === 0) throw ApiError.badRequest('Payout status changed concurrently');

      const entryUpdate = await tx.ledgerEntry.updateMany({ where: { eventId: `payout:${payout.id}:reservation`, status: 'PENDING' }, data: { status: 'VOID' } });
      if (entryUpdate.count === 0) throw ApiError.badRequest('Reservation ledger entry not found or invalid state');
      
      await ledgerService.createLedgerEntry({
        shopId: payout.shopId,
        type: 'PAYOUT_REJECT_REFUND',
        amount: payout.amount,
        description: 'Payout request rejected refund',
        counterparty: 'PLATFORM',
        createdBy: 'ADMIN',
        eventId: `payout:${payout.id}:rejected`
      }, tx, outboxIds);

      return payout;
    });

    await realtimeService.publishQueued(outboxIds);

    // The reserved amount is back in the balance, so say so — otherwise the
    // money quietly reappearing is the only signal the shop gets.
    await tellShop(
      result.shopId,
      `Your payout request of ${rupees(result.amount)} was declined and the amount is back in your balance.`,
      'warning',
      'Your EzyPrint payout request was declined'
    );

    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.post('/:id/cancel', authenticate, authorize('SHOP_OWNER', 'ADMIN'), sensitiveLimiter, validate(otpGuardedSchema), async (req, res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { otp } = req.body;

    const payoutId = req.params.id as string;

    // Everything that can reject this is checked before the code is spent.
    // Consuming first meant a cancellation the server was never going to allow
    // still destroyed the OTP, so every retry needed a fresh email and failed
    // again the same way — which reads as "OTP not working" rather than "this
    // payout cannot be cancelled".
    const existing = await prisma.payout.findUnique({ where: { id: payoutId } });
    if (!existing) throw ApiError.notFound('Payout not found');

    if (req.user.userType === 'SHOP_OWNER') {
      const shop = await prisma.shop.findUnique({ where: { ownerUserId: req.user.userId } });
      if (!shop || shop.id !== existing.shopId) {
        throw ApiError.forbidden('Payout does not belong to your shop');
      }
    }

    if (!CANCELLABLE_PAYOUT_STATUSES.includes(existing.status)) {
      throw ApiError.badRequest(
        `A payout that is ${existing.status.toLowerCase().replace(/_/g, ' ')} cannot be cancelled.`
      );
    }

    await otpService.consumeOtp(req.user.userId, `payout_${payoutId}`, otp);

    const outboxIds: string[] = [];
    let cancelled: { shopId: string; amount: number } | null = null;

    const result = await prisma.$transaction(async (tx) => {
      const payout = await tx.payout.findUnique({ where: { id: payoutId } });
      if (!payout) throw ApiError.notFound('Payout not found');
      cancelled = { shopId: payout.shopId, amount: payout.amount };

      // Still guarded, despite the check above: that read is outside this
      // transaction, so an admin approving in the meantime must lose the race
      // rather than have their approval silently cancelled.
      const updated = await tx.payout.updateMany({
        where: { id: payout.id, status: { in: CANCELLABLE_PAYOUT_STATUSES } },
        data: { status: 'CANCELLED' }
      });
      if (updated.count === 0) throw ApiError.badRequest('This payout was changed by someone else just now. Reload and try again.');

      // Best effort, not a precondition. A reservation is only PENDING while the
      // payout is; once approved it is SETTLED, and a disputed payout has
      // always been through approval. Requiring PENDING here rejected every
      // dispute resolution — the very case the dashboard offers this for.
      await tx.ledgerEntry.updateMany({
        where: { eventId: `payout:${payout.id}:reservation`, status: 'PENDING' },
        data: { status: 'VOID' },
      });

      // The money comes back the same way in both cases. The reservation
      // debited the balance when the payout was requested and nothing has
      // returned it since — voiding is a label, this is the movement. Its
      // eventId is unique, so a retry cannot credit twice.
      await ledgerService.createLedgerEntry({
        shopId: payout.shopId,
        type: 'PAYOUT_CANCEL_REFUND',
        amount: payout.amount,
        description: 'Payout request cancelled refund',
        counterparty: 'PLATFORM',
        createdBy: req.user?.userType === 'ADMIN' ? 'ADMIN' : 'SHOP',
        eventId: `payout:${payout.id}:cancelled`
      }, tx, outboxIds);

      return updated;
    });

    await realtimeService.publishQueued(outboxIds);

    // Cancelling is open to both sides, so who hears depends on who acted.
    // Telling someone about their own button press is noise, and a shop that
    // buzzes at itself learns to ignore the one that matters.
    if (cancelled) {
      const { shopId: cancelledShopId, amount: cancelledAmount } = cancelled;
      if (req.user?.userType === 'ADMIN') {
        await tellShop(cancelledShopId, `Your payout request of ${rupees(cancelledAmount)} was cancelled by an admin.`, 'warning', 'Your EzyPrint payout request was cancelled');
      } else {
        notifyService.notifyAdmins(`A shop cancelled its payout request of ${rupees(cancelledAmount)}.`);
      }
    }

    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.post('/:id/confirm', authenticate, authorize('SHOP_OWNER'), async (req, res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();

    const payout = await prisma.payout.findUnique({ where: { id: req.params.id as string } });
    if (!payout) throw ApiError.notFound('Payout not found');
    
    const shop = await prisma.shop.findUnique({ where: { ownerUserId: req.user.userId } });
    if (!shop || shop.id !== payout.shopId) throw ApiError.forbidden('Payout does not belong to your shop');
    
    const updated = await prisma.payout.updateMany({
      where: { id: req.params.id as string, status: { in: ['PAID', 'IN_TRANSIT'] } },
      data: { status: 'CONFIRMED', confirmedAt: new Date() }
    });
    if (updated.count === 0) throw ApiError.badRequest('Payout not found or invalid state');
    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/dispute', authenticate, authorize('SHOP_OWNER'), async (req, res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { shopOwnerNote } = req.body;

    const payout = await prisma.payout.findUnique({ where: { id: req.params.id as string } });
    if (!payout) throw ApiError.notFound('Payout not found');
    
    const shop = await prisma.shop.findUnique({ where: { ownerUserId: req.user.userId } });
    if (!shop || shop.id !== payout.shopId) throw ApiError.forbidden('Payout does not belong to your shop');
    
    const updated = await prisma.payout.updateMany({
      where: { id: req.params.id as string, status: { in: ['PAID', 'IN_TRANSIT'] } },
      data: { status: 'DISPUTED', shopOwnerNote }
    });
    if (updated.count === 0) throw ApiError.badRequest('Payout not found or invalid state');
    notifyService.notifyAdmins(
      `${shop.name} is disputing a payout of ${rupees(payout.amount)} — they say it never arrived.`,
      'error'
    );

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

router.post('/manual', authenticate, authorize('ADMIN'), sensitiveLimiter, validate(manualPayoutWithOtpSchema), async (req, res, next) => {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { shopId, amount, adminNote, otp } = req.body;

    await otpService.consumeOtp(req.user.userId, `payout_${shopId}`, otp);

    // shopName is denormalized onto the payout and is required by the schema.
    // Taking it from the request body let a caller record a payout against one
    // shop under another shop's name.
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { name: true } });
    if (!shop) throw ApiError.notFound('Shop not found');

    const outboxIds: string[] = [];

    const result = await prisma.$transaction(async (tx) => {
      const payout = await tx.payout.create({
        data: {
          shopId,
          shopName: shop.name,
          amount: Number(amount),
          adminNote,
          status: 'PAID',
          paidAt: new Date()
        }
      });

      await ledgerService.createLedgerEntry({
        shopId,
        type: 'MANUAL_PAYOUT_DEDUCTION',
        amount: Number(amount),
        description: 'Manual payout',
        counterparty: 'PLATFORM',
        createdBy: 'ADMIN',
        eventId: `payout:${payout.id}:manual`
      }, tx, outboxIds);

      return payout;
    });

    await realtimeService.publishQueued(outboxIds);

    await tellShop(shopId, `${rupees(Number(amount))} has been sent to your bank account.`, 'success', 'Your EzyPrint payout has been sent');

    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

export default router;
