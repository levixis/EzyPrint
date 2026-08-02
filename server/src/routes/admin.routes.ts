import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { sendOTPEmail } from '../services/email.service';
import * as otpService from '../services/otp.service';
import { otpRequestLimiter } from '../middleware/rateLimiter';
import { requestOtpSchema } from '../validators/schemas';
import { env } from '../config/env';
import type { Request, Response, NextFunction } from 'express';

const router = Router();

// ────────────────────────────────────────────────────────────
// POST /api/v1/admin/otp — Request a one-time verification code
// ────────────────────────────────────────────────────────────
router.post('/otp', authenticate, otpRequestLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw ApiError.unauthorized();

    const parsed = requestOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      throw ApiError.badRequest('A valid actionId is required.');
    }
    const { actionId } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, email: true, type: true },
    });
    if (!user || !user.email) throw ApiError.badRequest('Account lacks a verified email address.');

    const otp = await otpService.issueOtp(user.id, actionId);

    // In dev mode without Gmail creds, log OTP to console instead of sending email
    if (env.isDev && (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD)) {
      console.log(`[DEV OTP] User ${user.email} action=${actionId} otp=${otp}`);
      res.json({ success: true, message: 'OTP logged to server console (dev mode — no email configured).' });
      return;
    }

    try {
      await sendOTPEmail(user.email, otp, actionId);
    } catch (mailError) {
      // Surfaced as itself rather than a bare 500. The admin is staring at a
      // verification dialog, and "internal server error" reads as a wrong code
      // or a broken payout — sending them to look at the wrong thing entirely.
      console.error('[admin/otp] could not send OTP email:', mailError);
      throw ApiError.internal(
        'Could not send the verification email. Check GMAIL_USER and GMAIL_APP_PASSWORD on the server, then try again.'
      );
    }

    res.json({ success: true, message: 'OTP sent successfully.' });
  } catch (error) {
    next(error);
  }
});

/**
 * Refuse to hard-delete a shop owner whose shops carry financial history.
 *
 * `LedgerEntry` and `Payout` both cascade on shop deletion, so deleting one
 * destroys the record of money that actually moved. Archiving keeps the account
 * unusable while leaving the trail intact for reconciliation, disputes and tax.
 */
async function assertShopsSafeToDelete(ownerUserId: string): Promise<void> {
  const shops = await prisma.shop.findMany({
    where: { ownerUserId },
    select: { id: true, name: true, pendingBalance: true, ledgerBalance: true, debtAmount: true },
  });

  for (const shop of shops) {
    const outstanding = shop.pendingBalance + shop.ledgerBalance + shop.debtAmount;
    if (outstanding !== 0) {
      throw ApiError.badRequest(
        `${shop.name} still has an unsettled balance. Settle it before deleting, or archive the shop instead.`
      );
    }

    const ledgerCount = await prisma.ledgerEntry.count({ where: { shopId: shop.id } });
    if (ledgerCount > 0) {
      throw ApiError.badRequest(
        `${shop.name} has ${ledgerCount} financial record(s) that must be retained. Archive the shop instead of deleting it.`
      );
    }
  }
}

// ────────────────────────────────────────────────────────────
// POST /api/v1/admin/action — Execute a verified admin action
// ────────────────────────────────────────────────────────────
router.post('/action', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { otp, action, targetUid } = req.body;
    if (!otp || !action) throw ApiError.badRequest('OTP and action type required.');

    const caller = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, type: true },
    });
    if (!caller) throw ApiError.notFound('User not found.');

    const isAdmin = caller.type === 'ADMIN';

    // Verify and consume the one-time code (single-use, atomic).
    await otpService.consumeOtp(caller.id, action, otp);

    // ── Admin actions on other users ──
    if (action === 'DELETE_USER' || action === 'ARCHIVE_USER') {
      if (!isAdmin) throw ApiError.forbidden('Action requires admin rights.');
      if (!targetUid) throw ApiError.badRequest('targetUid is required.');

      if (action === 'ARCHIVE_USER') {
        await prisma.$transaction(async (tx) => {
          await tx.shop.updateMany({
            where: { ownerUserId: targetUid },
            data: { isArchived: true, isOpen: false },
          });
        });

        res.json({ success: true, message: 'Shop archived successfully.' });
        return;
      }

      if (action === 'DELETE_USER') {
        // Deleting a shop cascades to its ledger entries and payouts. Those are
        // the financial record of money that moved between real parties, so a
        // shop that has traded is archived instead of deleted — an unsettled
        // balance in either direction must stay auditable.
        await assertShopsSafeToDelete(targetUid);

        await prisma.$transaction(async (tx) => {
          // Mark pending payouts as disputed
          const shops = await tx.shop.findMany({
            where: { ownerUserId: targetUid },
            select: { id: true, name: true },
          });
          for (const shop of shops) {
            await tx.payout.updateMany({
              where: { shopId: shop.id, status: 'PENDING' },
              data: { status: 'DISPUTED', adminNote: 'Auto-disputed: User deleted by admin' },
            });
            // Mark orders as belonging to deleted shop
            await tx.order.updateMany({
              where: { shopId: shop.id },
              data: { deletedShop: true, shopName: shop.name },
            });
          }
          // Cancel active orders for this user
          await tx.order.updateMany({
            where: {
              userId: targetUid,
              status: { in: ['PENDING_PAYMENT', 'PENDING_APPROVAL', 'PRINTING', 'READY_FOR_PICKUP'] },
            },
            data: { status: 'CANCELLED' },
          });
          // Anonymize tickets
          await tx.ticket.updateMany({
            where: { raisedBy: targetUid },
            data: { raisedByName: 'Deleted User' },
          });
          // Delete notifications for this user
          await tx.notification.deleteMany({
            where: { recipientUserId: targetUid },
          });
          // Delete shops (cascades to bank details, payout methods, etc.)
          await tx.shop.deleteMany({ where: { ownerUserId: targetUid } });
          // Delete the user (cascades to refresh tokens, etc.)
          await tx.user.delete({ where: { id: targetUid } });
        });

        res.json({ success: true, message: 'User and shop deleted successfully.' });
        return;
      }
    }

    // ── Self-service actions ──
    if (action === 'DELETE_OWN_ACCOUNT') {
      const isShopOwner = caller.type === 'SHOP_OWNER';

      // Same protection as admin deletion: a shop owner cannot erase the record
      // of money owed to or by them by closing their own account.
      if (isShopOwner) {
        await assertShopsSafeToDelete(caller.id);
      }

      await prisma.$transaction(async (tx) => {
        if (isShopOwner) {
          const shops = await tx.shop.findMany({
            where: { ownerUserId: caller.id },
            select: { id: true, name: true },
          });
          for (const shop of shops) {
            await tx.payout.updateMany({
              where: { shopId: shop.id, status: 'PENDING' },
              data: { status: 'DISPUTED', adminNote: 'Auto-disputed: Shop owner deleted account' },
            });
            await tx.order.updateMany({
              where: { shopId: shop.id },
              data: { deletedShop: true, shopName: shop.name },
            });
          }
          await tx.shop.deleteMany({ where: { ownerUserId: caller.id } });
        }
        // Cancel active orders
        await tx.order.updateMany({
          where: {
            userId: caller.id,
            status: { in: ['PENDING_PAYMENT', 'PENDING_APPROVAL', 'PRINTING', 'READY_FOR_PICKUP'] },
          },
          data: { status: 'CANCELLED' },
        });
        await tx.ticket.updateMany({
          where: { raisedBy: caller.id },
          data: { raisedByName: 'Deleted User' },
        });
        await tx.notification.deleteMany({ where: { recipientUserId: caller.id } });
        await tx.user.delete({ where: { id: caller.id } });
      });

      res.json({ success: true, message: 'Account deleted successfully.' });
      return;
    }

    if (action === 'ARCHIVE_OWN_SHOP') {
      if (caller.type !== 'SHOP_OWNER') throw ApiError.forbidden('Only shop owners can archive their shop.');

      await prisma.shop.updateMany({
        where: { ownerUserId: caller.id },
        data: { isArchived: true, isOpen: false },
      });

      res.json({ success: true, message: 'Shop archived successfully.' });
      return;
    }

    throw ApiError.badRequest('Unsupported action.');
  } catch (error) {
    next(error);
  }
});

// ────────────────────────────────────────────────────────────
// POST /api/v1/admin/check-returning-shop
// ────────────────────────────────────────────────────────────
router.post('/check-returning-shop', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { exists: false } });
  } catch (error) {
    next(error);
  }
});

export default router;
