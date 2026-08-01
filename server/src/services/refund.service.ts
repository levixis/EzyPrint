import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';
import * as ledgerService from './ledger.service';
import * as realtimeService from './realtime.service';

/**
 * Refund execution — the network call to Razorpay and the local persistence
 * that follows it.
 *
 * Extracted so the admin-resolve path and the automatic cancellation refund
 * run the same code. Two copies of "move money and write the ledger" is how
 * the two drift into disagreeing about who absorbs what.
 */

/**
 * Ask Razorpay to refund a payment.
 *
 * `idempotencyKey` is the RefundRequest id, so a retry after a timeout — where
 * the first call may well have succeeded — returns the original refund rather
 * than issuing a second one. Without it, a network blip during a refund is a
 * double payout.
 */
async function callRazorpayRefund(
  paymentId: string,
  amountPaise: number,
  idempotencyKey: string,
  orderId: string
): Promise<string> {
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');

  const response = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}/refund`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${auth}`,
      'X-Refund-Idempotency': idempotencyKey,
    },
    // `amount` is already paise, which is the unit Razorpay expects.
    body: JSON.stringify({ amount: amountPaise, notes: { orderId } }),
  });

  const data = await response.json() as any;

  if (!response.ok) {
    // Leaving the request in PROCESSING_REFUND is deliberate: the money may or
    // may not have moved, so an admin must look rather than the system
    // guessing. The idempotency key makes a manual retry safe.
    throw ApiError.internal(`Razorpay Refund Failed: ${data.error?.description || 'Unknown error'}`);
  }

  return data.id;
}

export interface ResolveRefundOptions {
  /**
   * Mark the order REFUNDED on success.
   *
   * True for the admin path, where refunding is the reason the order ends.
   * False for a cancellation, where the order is already CANCELLED and that
   * is the more meaningful terminal state — overwriting it would lose why the
   * order ended, and `VALID_TRANSITIONS` has no CANCELLED -> REFUNDED edge
   * anyway.
   */
  setOrderRefunded: boolean;
  /** Recorded on the ledger entry. */
  createdBy: 'ADMIN' | 'SYSTEM';
  adminNote?: string;
  resolvedBy?: string;
}

/**
 * Carry a refund request that is already claimed into PROCESSING_REFUND
 * through to settlement.
 *
 * The caller must have claimed it first with an atomic status guard — this
 * function performs the network call, which must never happen inside a
 * database transaction holding locks.
 */
export async function settleClaimedRefund(
  requestId: string,
  options: ResolveRefundOptions
): Promise<void> {
  const request = await prisma.refundRequest.findUnique({
    where: { id: requestId },
    include: { order: true },
  });
  if (!request) throw ApiError.notFound('Refund request not found');

  const amount = request.refundAmount ?? request.order.totalPrice;
  let razorpayRefundId = request.razorpayRefundId;
  let finalStatus: 'RESOLVED_REFUNDED' | 'REFUND_SETTLED_OFFLINE' = 'RESOLVED_REFUNDED';

  if (request.order.razorpayPaymentId) {
    if (!razorpayRefundId) {
      razorpayRefundId = await callRazorpayRefund(
        request.order.razorpayPaymentId,
        amount,
        request.id,
        request.orderId
      );
    }
  } else {
    // Nothing was ever charged through Razorpay — cash or a free order. The
    // request still closes, just without a gateway refund.
    finalStatus = 'REFUND_SETTLED_OFFLINE';
  }

  const outboxIds: string[] = [];

  await prisma.$transaction(async (tx) => {
    const updated = await tx.refundRequest.updateMany({
      where: { id: requestId, status: 'PROCESSING_REFUND' },
      data: {
        status: finalStatus,
        razorpayRefundId,
        refundAmount: amount,
        adminResolvedAt: new Date(),
        ...(options.adminNote ? { adminNote: options.adminNote } : {}),
        ...(options.resolvedBy ? { resolvedBy: options.resolvedBy } : {}),
      },
    });

    // Another delivery of the same settlement got here first. The Razorpay
    // call above was idempotent, so nothing has been double-refunded.
    if (updated.count === 0) return;

    if (options.setOrderRefunded) {
      await tx.order.updateMany({
        where: { id: request.orderId },
        data: { status: 'REFUNDED' },
      });
    }

    // The student is refunded in full, but the shop is liable only for what it
    // actually received — the platform absorbs its own base fee.
    const shopShare = await ledgerService.shopShareOfRefund(tx, request.orderId, amount);

    if (shopShare > 0) {
      await ledgerService.createLedgerEntry({
        shopId: request.shopId,
        type: 'REFUND_DEDUCTION',
        amount: shopShare,
        description: `Refund for order ${request.orderId}`,
        counterparty: 'STUDENT',
        createdBy: options.createdBy,
        orderId: request.orderId,
        eventId: `refund:${request.id}`,
        // The student has already been refunded by Razorpay at this point. If
        // the shop's balance no longer covers it — because they were paid out
        // in the meantime — the shortfall becomes debt offset against future
        // earnings. Refusing here would leave the platform out of pocket with
        // no record of who owes it.
        allowDebt: true,
      }, tx, outboxIds);
    }
  });

  await realtimeService.publishQueued(outboxIds);
}

/**
 * Create the refund request for an order being cancelled after payment.
 *
 * Runs inside the caller's cancellation transaction so the request cannot
 * exist without the cancellation, nor the cancellation without the request.
 * Returns null when there is nothing to refund.
 *
 * `orderId` is unique on RefundRequest, so a student who already raised a
 * refund claim before cancelling reuses that row rather than colliding with
 * it. The status guard means an already-settled claim is left alone.
 */
export async function claimCancellationRefund(
  tx: any,
  order: { id: string; shopId: string; userId: string; totalPrice: number; razorpayPaymentId: string | null }
): Promise<string | null> {
  // Never charged, nothing to give back.
  if (!order.razorpayPaymentId || order.totalPrice <= 0) return null;

  const existing = await tx.refundRequest.findUnique({ where: { orderId: order.id } });

  if (existing) {
    // Already settled or already denied — leave it be.
    if (!['PENDING_SHOP', 'APPROVED_BY_SHOP', 'ESCALATED_TO_ADMIN', 'AUTO_ESCALATED'].includes(existing.status)) {
      return null;
    }

    const claimed = await tx.refundRequest.updateMany({
      where: { id: existing.id, status: existing.status },
      data: { status: 'PROCESSING_REFUND', refundAmount: order.totalPrice },
    });
    return claimed.count === 1 ? existing.id : null;
  }

  const created = await tx.refundRequest.create({
    data: {
      orderId: order.id,
      studentId: order.userId,
      shopId: order.shopId,
      reason: 'Order cancelled',
      // Straight to PROCESSING_REFUND: a cancellation is its own approval, so
      // there is no shop or admin decision left to make.
      status: 'PROCESSING_REFUND',
      refundAmount: order.totalPrice,
    },
  });

  return created.id;
}
