import { Router } from 'express';
import { authenticate } from '../middleware/auth';
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

/**
 * Refuse to delete an account whose orders are money, not just history.
 *
 * `Order.user` is `onDelete: Cascade`, so `user.delete()` takes every order the
 * account ever placed with it. `LedgerEntry.orderId` is a plain column with no
 * foreign key, so the ledger rows *survive* — and are left pointing at orders
 * that no longer exist. That is unrecoverable: the entry says a shop earned
 * money for an order nobody can produce, and no reconciliation against Razorpay
 * can put it back.
 *
 * Two separate refusals, because they are two separate problems:
 *
 *  1. Orders that are paid and unfulfilled. Both delete paths cancel these with
 *     a bare status write, bypassing `claimCancellationRefund` — which is the
 *     mechanism that makes every *other* cancellation return the money. So the
 *     student was charged, the order was cancelled, the shop was never credited
 *     and nobody was refunded.
 *  2. Orders a ledger entry refers to. Deleting these is the corruption above.
 *
 * `assertShopsSafeToDelete` already establishes this shape for the shop side of
 * the same account. This is the student side, which had nothing.
 *
 * The consequence is real and worth stating: a student who has completed an
 * order can no longer delete their account through this route. That is the
 * correct trade against silently destroying financial records, but it makes
 * anonymise-in-place — keeping the user row, clearing the personal fields — the
 * proper long-term answer rather than deletion.
 */
export async function assertOrdersSafeToDelete(userId: string): Promise<void> {
  const unfulfilledPaid = await prisma.order.count({
    where: {
      userId,
      status: { in: ['PENDING_APPROVAL', 'PRINTING', 'READY_FOR_PICKUP'] },
    },
  });

  if (unfulfilledPaid > 0) {
    throw ApiError.badRequest(
      `This account has ${unfulfilledPaid} paid order(s) that have not been fulfilled. ` +
      `Cancel them first — cancelling refunds the student — then delete the account.`
    );
  }

  const orderIds = (
    await prisma.order.findMany({ where: { userId }, select: { id: true } })
  ).map((o) => o.id);

  if (orderIds.length === 0) return;

  const ledgerCount = await prisma.ledgerEntry.count({
    where: { orderId: { in: orderIds } },
  });

  if (ledgerCount > 0) {
    throw ApiError.badRequest(
      `This account's orders are referenced by ${ledgerCount} financial record(s). ` +
      `Deleting the account would destroy the orders while the ledger entries remain, ` +
      `leaving money recorded against orders that no longer exist.`
    );
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

    // ── Everything that can refuse this action, checked BEFORE the code is
    //    spent ──
    //
    // `consumeOtp` deletes the code atomically, so anything that throws after
    // it has destroyed a code the caller then cannot reuse. For a refusal that
    // is *permanent* — an account whose orders the ledger refers to will still
    // be that way on the next attempt — that turns one clear "you cannot delete
    // this yet" into an unbounded loop of request-code, fail, request-code,
    // each failure looking like a broken OTP rather than a settled answer.
    //
    // `/payouts/:id/cancel` and `/mark-paid` already established this ordering
    // for exactly this reason and say so in their own comments; this handler
    // was checking after, and the deletion guards added here made that
    // materially worse rather than merely untidy.
    if (action === 'DELETE_USER') {
      if (!isAdmin) throw ApiError.forbidden('Action requires admin rights.');
      if (!targetUid) throw ApiError.badRequest('targetUid is required.');
      await assertShopsSafeToDelete(targetUid);
      await assertOrdersSafeToDelete(targetUid);
    }

    if (action === 'DELETE_OWN_ACCOUNT') {
      if (caller.type === 'SHOP_OWNER') await assertShopsSafeToDelete(caller.id);
      await assertOrdersSafeToDelete(caller.id);
    }

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
        //
        // Both guards ran above, before the OTP was consumed.

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
      // Both guards ran above, before the OTP was consumed. The orders one
      // applies to every account type: a student's own orders cascade away on
      // deletion exactly the same way, and the ledger entries naming them do
      // not. Self-service is if anything the more likely route — it needs only
      // a code sent to the caller's own address.

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
//
// NOT IMPLEMENTED — answers `{ exists: false }` to everything.
//
// The client calls this during Google sign-in (`checkReturningShopOwner` in
// LoginPage) to spot an owner coming back to an archived shop. Because the
// answer is a constant, that flow has never once triggered: a returning owner
// is treated as a brand-new signup.
//
// Two things to know before implementing it:
//
//  1. It is the only route on this router with no `authenticate`, and it takes
//     an email. Answering truthfully would turn it into an unauthenticated
//     oracle for "does this address have an account", against a campus where
//     the addresses are predictable. Whoever implements it has to decide the
//     auth story first — the password-reset endpoints next door are
//     deliberately enumeration-safe and are the precedent to follow.
//  2. It is reached mid-sign-in, so adding `authenticate` is not free; the
//     caller's token state at that point needs checking against LoginPage.
//
// Left inert rather than half-fixed: a stub that lies consistently is safer
// than one that leaks, and the lie is at least confined to one feature.
// ────────────────────────────────────────────────────────────
router.post('/check-returning-shop', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { exists: false } });
  } catch (error) {
    next(error);
  }
});

export default router;
