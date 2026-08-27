import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';
import type { RefundRequestStatus } from '@prisma/client';
import * as ledgerService from './ledger.service';
import * as realtimeService from './realtime.service';
import * as notifyService from './notify.service';

/**
 * Refund execution — the network call to Razorpay and the local persistence
 * that follows it.
 *
 * Extracted so the admin-resolve path and the automatic cancellation refund
 * run the same code. Two copies of "move money and write the ledger" is how
 * the two drift into disagreeing about who absorbs what.
 */

/**
 * Razorpay's own view of a refund, narrowed to the distinction that matters.
 *
 * The gateway also reports `failed`, but never in the response to the refund
 * call itself — a synchronous failure comes back as a non-2xx and throws below.
 * `failed` only ever arrives later, on the `refund.failed` webhook.
 */
type RazorpayRefundStatus = 'pending' | 'processed';

/**
 * Ask Razorpay to refund a payment.
 *
 * `idempotencyKey` is the RefundRequest id, so a retry after a timeout — where
 * the first call may well have succeeded — returns the original refund rather
 * than issuing a second one. Without it, a network blip during a refund is a
 * double payout.
 */
/**
 * The idempotency key for one refund attempt, in the format Razorpay accepts.
 *
 * Razorpay constrains the `X-Refund-Idempotency` value to at least 10
 * characters of letters, digits, hyphens and underscores only. A hyphen is
 * therefore the separator — a colon reads naturally and is what the ledger's
 * own event ids use, but it is not in that set, so the gateway would reject
 * every retry that carried one. A RefundRequest id is a 25-character cuid, so
 * the length floor is met by the id alone.
 *
 * Attempt 1 is the bare request id, unchanged from before retries existed — so
 * a refund already in flight at the gateway keeps answering to the key it was
 * created with across a deploy.
 *
 * Later attempts are suffixed, and only a *failed* attempt advances the number
 * (see `refundAttemptNumber`). A crashed-before-commit attempt deliberately
 * keeps its key: the refund may well have been made, and presenting the same
 * key is what makes Razorpay return it instead of issuing a second one.
 */
function refundGatewayKey(requestId: string, attempt: number): string {
  return attempt <= 1 ? requestId : `${requestId}-retry-${attempt}`;
}

async function callRazorpayRefund(
  paymentId: string,
  amountPaise: number,
  idempotencyKey: string,
  orderId: string
): Promise<{ id: string; status: RazorpayRefundStatus }> {
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

  // `status` is the field that decides whether the student has their money or
  // is merely owed it. It was previously discarded, and a 2xx alone was read as
  // completion — which is what let a refund Razorpay had only *accepted* be
  // announced as one it had settled.
  //
  // Anything other than an explicit `processed` is treated as pending. An
  // unrecognised value must not be optimistically upgraded: the cost of waiting
  // for a webhook that confirms is a delayed notification, and the cost of
  // guessing wrong is telling someone their money arrived when it did not.
  return {
    id: data.id,
    status: data.status === 'processed' ? 'processed' : 'pending',
  };
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

  /**
   * Which attempt this is, and therefore which idempotency keys it uses.
   *
   * Read, never incremented here. `attempts` counts attempts the gateway has
   * failed, so it advances in `applyRefundFailed` and nowhere else — a retry
   * only becomes a new attempt once the previous one is known to be dead.
   */
  const attempt = ledgerService.refundAttemptNumber(request);

  /**
   * Where this refund actually stands, which is not the same as whether the
   * call succeeded.
   *
   *  - `RESOLVED_REFUNDED`      the money has moved and we know it
   *  - `PROCESSING_REFUND`      accepted, in flight, awaiting `refund.processed`
   *  - `REFUND_SETTLED_OFFLINE` no gateway leg existed to wait on
   */
  let finalStatus: 'RESOLVED_REFUNDED' | 'PROCESSING_REFUND' | 'REFUND_SETTLED_OFFLINE' =
    'PROCESSING_REFUND';

  /**
   * Whether this call is the one that started the gateway leg.
   *
   * The admin claim deliberately re-admits `PROCESSING_REFUND` so a stuck
   * refund can be retried, and a retry now finds the request in the same status
   * it left it in — so the status guard alone no longer bounds the "in
   * progress" notice to one. An admin pressing retry should not re-tell the
   * student something they were told an hour ago.
   */
  let initiatedHere = false;

  if (request.order.razorpayPaymentId) {
    if (!razorpayRefundId) {
      const accepted = await callRazorpayRefund(
        request.order.razorpayPaymentId,
        amount,
        // Per attempt, not per request. Keyed on the request id alone, a retry
        // after a failed refund handed Razorpay the key of the refund it had
        // already failed and got that same dead refund back — so the retry
        // never issued anything and the student was never paid.
        //
        // Only a *failed* attempt advances the number, so this still returns
        // the original refund when an earlier attempt succeeded at the gateway
        // and lost its local transaction — which is the case the key was
        // introduced for and must keep protecting.
        refundGatewayKey(request.id, attempt),
        request.orderId
      );
      razorpayRefundId = accepted.id;
      initiatedHere = true;
      // Instant refunds do exist, and when Razorpay itself reports `processed`
      // in the response that is confirmation — waiting for a webhook to repeat
      // what we have already been told would strand the student in limbo.
      finalStatus = accepted.status === 'processed' ? 'RESOLVED_REFUNDED' : 'PROCESSING_REFUND';
    }
    // A refund id already on the row means the gateway call happened on an
    // earlier attempt whose local transaction did not commit. We have no
    // response to read a status from, so this stays PROCESSING_REFUND and
    // waits for the webhook — assuming completion here would be assuming it
    // about a call we never saw the result of.
    //
    // This branch is only reachable for a refund that is genuinely in flight.
    // A refund the gateway *failed* has its id cleared by `applyRefundFailed`
    // precisely so it does not land here: that id is dead, and treating it as
    // in-flight is what made a retry a silent no-op that then waited forever
    // for a webhook that had already been delivered.
  } else {
    // Nothing was ever charged through Razorpay — cash or a free order. There
    // is no asynchronous leg to be honest about, so this settles immediately.
    finalStatus = 'REFUND_SETTLED_OFFLINE';
  }

  /** True once the money is known to have moved, not merely to have been sent. */
  const isConfirmed = finalStatus !== 'PROCESSING_REFUND';

  /**
   * Whether this refund returns the whole order, or only part of it.
   *
   * No endpoint here issues a partial refund any more — `resolveRefundSchema`
   * stopped accepting an amount, because the rest of the system could not
   * honour one. This guard is not left over from that; it covers the case that
   * remains.
   *
   * A refund issued straight from the Razorpay dashboard can be partial, and
   * `applyRefundProcessed` writes whatever the gateway reports onto the order.
   * Promoting to REFUNDED regardless is what made a ₹100 refund on a ₹500 order
   * tell both dashboards the student had their money back while ₹400 was kept,
   * and drop the order's whole page cost out of revenue while the ledger had
   * debited only the ₹100 share.
   *
   * So a partial refund leaves the order in whatever terminal state it already
   * holds. `refundAmount` on the order records how much came back, which is the
   * honest answer, and `getShopAggregate` nets the ledger deduction off revenue
   * rather than discarding the order.
   */
  const isFullRefund = amount >= request.order.totalPrice;

  const outboxIds: string[] = [];
  // Only the delivery that actually moved the row may announce it — a repeat
  // delivery reaches the guard below and must stay silent rather than tell the
  // student a second time that their money is on the way.
  let settledHere = false;

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
    settledHere = true;

    // Record the outcome on the order itself, whatever terminal state it keeps.
    //
    // `Order.refundId` / `refundStatus` / `refundAmount` survived the migration
    // from Firebase, where the legacy functions wrote them. Nothing on this side
    // ever did — they were read and never populated. The admin dashboard derives
    // its payment badge from them (`getPaymentTrackingStatus`), so its check for
    // "cancelled, paid, and no refund recorded" was true for every cancelled
    // order forever: two orders that had been refunded down to the paisa, with
    // Razorpay refund ids against them, sat on the admin's screen labelled
    // "Needs Refund".
    //
    // Written here rather than at the call sites because this is the one place
    // every settlement path reaches — admin resolution, shop self-refund, and
    // the automatic refund behind a cancellation.
    await tx.order.updateMany({
      where: { id: request.orderId },
      data: {
        // `setOrderRefunded` controls the *status*, but only once the refund is
        // confirmed and only when it returns the whole order. A cancellation
        // keeps CANCELLED regardless — it is the more meaningful record of why
        // the order ended, and VALID_TRANSITIONS has no CANCELLED -> REFUNDED
        // edge anyway.
        ...(options.setOrderRefunded && isConfirmed && isFullRefund
          ? { status: 'REFUNDED' as const }
          : {}),
        // Falls back to the request id when nothing went through the gateway,
        // so an offline settlement is still recorded as settled rather than
        // reading as unrefunded.
        refundId: razorpayRefundId ?? request.id,
        // 'pending' until the gateway confirms. Both dashboards already read
        // this field and already render all three values — the student card
        // shows "Refund Initiated" and the admin badge "Refund Pending" — so
        // the only thing that was ever missing was the server telling the
        // truth about which one applied.
        refundStatus: isConfirmed
          ? ledgerService.ORDER_REFUND_STATUS.processed
          : ledgerService.ORDER_REFUND_STATUS.pending,
        refundAmount: amount,
      },
    });

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
        // Per attempt: a retry must be a new entry, not a duplicate of the one
        // whose reversal already credited the shop back.
        eventId: ledgerService.refundLedgerEventId(request.id, attempt),
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

  // After commit, and never awaited into the caller's latency. Every settlement
  // route — admin resolution, shop self-refund, and the automatic refund behind
  // a cancellation — funnels through here, so this is the one place that covers
  // all three.
  if (!settledHere) return;

  const recipient = {
    studentUserId: request.order.userId,
    orderId: request.orderId,
    shopId: request.shopId,
    amountPaise: amount,
  };

  if (isConfirmed) {
    notifyService.notifyRefundSettled({
      ...recipient,
      throughGateway: finalStatus === 'RESOLVED_REFUNDED',
    });
    return;
  }

  // Accepted, not landed. The student hears that it is on its way, and hears
  // again from the `refund.processed` / `refund.failed` webhook when it is
  // actually one or the other. Saying "refunded" here is the claim this whole
  // split exists to stop making.
  if (initiatedHere) {
    notifyService.notifyRefundInitiated(recipient);
  }
}

/**
 * Statuses an existing refund claim may be taken over from when the order it
 * belongs to is cancelled.
 *
 * `REJECTED_BY_SHOP` is here, and its absence was a bug: the list read as
 * "already settled or already denied", but a rejected claim is neither — the
 * student can still escalate it. So this sequence, all of it reachable through
 * the UI, left a paid order cancelled with the money kept:
 *
 *   1. student raises a refund claim; the shop rejects it
 *   2. the shop then cancels the order, which it may do from PENDING_APPROVAL,
 *      PRINTING or READY_FOR_PICKUP
 *   3. this returned null — no refund issued, none queued
 *
 * The rejected claim was an argument about a *dispute*. A cancellation is the
 * shop deciding unilaterally that the order will not be fulfilled, and that
 * has to return the money whatever was argued earlier.
 *
 * `REFUND_FAILED` is deliberately excluded. Those rows belong to the admin and
 * shop retry paths, which clear the dead gateway id and advance the attempt
 * counter before trying again; re-claiming one here would reuse a spent
 * idempotency key. `RESOLVED_*` and `REFUND_SETTLED_OFFLINE` are excluded
 * because they are genuinely finished.
 *
 * Named and exported so it sits beside `SHOP_CLAIMABLE_STATUSES`,
 * `ADMIN_ACTIONABLE_STATUSES` and `ADMIN_APPROVABLE_STATUSES` rather than
 * being a fourth inline copy — which is exactly how it came to disagree with
 * them.
 */
export const CANCELLATION_CLAIMABLE_STATUSES: RefundRequestStatus[] = [
  'PENDING_SHOP',
  'APPROVED_BY_SHOP',
  'REJECTED_BY_SHOP',
  'ESCALATED_TO_ADMIN',
  'AUTO_ESCALATED',
];

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
    // Nothing left to take over — see CANCELLATION_CLAIMABLE_STATUSES.
    if (!CANCELLATION_CLAIMABLE_STATUSES.includes(existing.status)) {
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

// ────────────────────────────────────────────────────────────
// SHOP-INITIATED REFUNDS
// ────────────────────────────────────────────────────────────

/**
 * Statuses a shop may take a refund claim over from.
 *
 * Exported alongside the admin lists below so every caller reads the same
 * definition. They used to be written out inline at each call site, and the
 * copies drifted: `REFUND_FAILED` was added here so a shop could retry a
 * refund the gateway had rejected, and the admin route's own list — the one
 * the enum, the cleanup service and the failure notification all promise will
 * work — was left without it. A failed refund had no way forward at all.
 *
 * Adding a status to the lifecycle now means adding it in one place per role,
 * with the three roles visible together.
 */
export const SHOP_CLAIMABLE_STATUSES: RefundRequestStatus[] = [
  'PENDING_SHOP',
  'APPROVED_BY_SHOP',
  'REJECTED_BY_SHOP',
  'ESCALATED_TO_ADMIN',
  'AUTO_ESCALATED',
  'REFUND_FAILED',
];

/**
 * Statuses an admin may act on — deny, or approve into a gateway refund.
 *
 * `REFUND_FAILED` belongs here because that state exists precisely so an admin
 * can retry: Razorpay rejected the transfer, the shop's deduction has been
 * reversed, and somebody has to decide what happens next.
 */
export const ADMIN_ACTIONABLE_STATUSES: RefundRequestStatus[] = [
  'ESCALATED_TO_ADMIN',
  'APPROVED_BY_SHOP',
  'AUTO_ESCALATED',
  'REFUND_FAILED',
];

/**
 * What an approval may additionally re-drive.
 *
 * `PROCESSING_REFUND` is approvable but not deniable: a refund already in
 * flight can be pushed along when it has stalled, but denying one whose money
 * may already have moved is not a decision this endpoint can honour.
 */
export const ADMIN_APPROVABLE_STATUSES: RefundRequestStatus[] = [
  ...ADMIN_ACTIONABLE_STATUSES,
  'PROCESSING_REFUND',
];

/** Kept for the shop path's existing call site. */
const CLAIMABLE_STATUSES = SHOP_CLAIMABLE_STATUSES;

export interface ShopRefundOutcome {
  /** True when the money has actually moved. False means it is waiting on an admin. */
  settled: boolean;
  /** Present when the refund escalated instead of settling. */
  escalationReason?: string;
  amount: number;
}

/**
 * Today's window, in the shop's own terms.
 *
 * Midnight IST rather than a rolling 24 hours: a shop owner reasons about
 * "today", and a rolling window makes the cap reset at a time nobody can
 * predict. IST because every shop and student here is in one timezone.
 */
function startOfDayIST(now = new Date()): Date {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

/**
 * Whether this refund exceeds what a shop may settle unaided, and why.
 *
 * Returns undefined when the shop may proceed. Kept pure and separate from the
 * database work because it is the whole policy: everything around it is
 * plumbing, and a limit that is wrong by one is the difference between a shop
 * being locked out of refunding and an abused account running unchecked.
 */
export function shopRefundEscalationReason(params: {
  amount: number;
  countToday: number;
  valueToday: number;
}): string | undefined {
  const { amount, countToday, valueToday } = params;

  if (amount > env.SHOP_REFUND_MAX_PER_REFUND_PAISE) {
    return `Refunds above ₹${env.SHOP_REFUND_MAX_PER_REFUND_PAISE / 100} need admin approval`;
  }
  if (countToday >= env.SHOP_REFUND_MAX_PER_DAY_COUNT) {
    return `Daily limit of ${env.SHOP_REFUND_MAX_PER_DAY_COUNT} refunds reached`;
  }
  if (valueToday + amount > env.SHOP_REFUND_MAX_PER_DAY_PAISE) {
    return `Daily refund total of ₹${env.SHOP_REFUND_MAX_PER_DAY_PAISE / 100} would be exceeded`;
  }
  return undefined;
}

/**
 * Refund an order on the shop's own authority, within velocity limits.
 *
 * A refund sends money back to whoever paid, so a shop approving one cannot
 * profit from it — the worst an abused account achieves is returning that
 * shop's earnings to real customers. Gating every refund on an admin buys
 * little and costs the student a wait on one person; the limits below bound
 * the damage instead, which is what payment processors do.
 *
 * Over any limit the claim is left for an admin rather than refused, so the
 * student's request is never lost — only slowed.
 */
export async function shopRefundOrder(params: {
  orderId: string;
  shopOwnerUserId: string;
  reason: string;
}): Promise<ShopRefundOutcome> {
  const { orderId, shopOwnerUserId, reason } = params;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, shopId: true, userId: true, status: true, totalPrice: true, razorpayPaymentId: true },
  });
  if (!order) throw ApiError.notFound('Order not found');

  const shop = await prisma.shop.findUnique({
    where: { ownerUserId: shopOwnerUserId },
    select: { id: true },
  });
  if (!shop || shop.id !== order.shopId) {
    throw ApiError.forbidden('This order belongs to another shop');
  }
  if (order.status === 'PENDING_PAYMENT' || order.status === 'PAYMENT_FAILED') {
    throw ApiError.badRequest('Nothing has been charged for this order yet');
  }
  if (order.status === 'REFUNDED') {
    throw ApiError.badRequest('This order has already been refunded');
  }

  const amount = order.totalPrice;
  let requestId = '';
  let escalationReason: string | undefined;

  await prisma.$transaction(async (tx) => {
    // Serialises this shop's refunds for the duration of the transaction, so
    // two approvals in flight together cannot both read the same day's total
    // and both decide they are under the cap. Released automatically at commit
    // or rollback; keyed on the shop, so other shops are unaffected.
    // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, and
    // Prisma cannot deserialize a void column — it takes the lock and then
    // throws on the way back, which surfaced as "Internal server error" on
    // every refund. The scheduler's locks read fine only because
    // pg_try_advisory_lock returns a boolean.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${order.shopId}))`;

    const since = startOfDayIST();
    const settledToday = await tx.refundRequest.findMany({
      where: {
        shopId: order.shopId,
        adminResolvedAt: { gte: since },
        status: { in: ['PROCESSING_REFUND', 'RESOLVED_REFUNDED', 'REFUND_SETTLED_OFFLINE'] },
      },
      select: { refundAmount: true },
    });

    const countToday = settledToday.length;
    const valueToday = settledToday.reduce((sum, r) => sum + (r.refundAmount ?? 0), 0);

    escalationReason = shopRefundEscalationReason({ amount, countToday, valueToday });

    const nextStatus: RefundRequestStatus = escalationReason ? 'APPROVED_BY_SHOP' : 'PROCESSING_REFUND';

    /**
     * Stamp the attempt's start time here, inside the lock, when this refund is
     * actually going ahead.
     *
     * The count above reads `adminResolvedAt`, and this transaction used not to
     * write it — `settleClaimedRefund` did, in a *different* transaction, after
     * the Razorpay round trip. So the advisory lock was serialising a read of a
     * value written outside it: every request that started while an earlier one
     * was still at the gateway counted zero prior refunds, and ten fired
     * together all passed a cap none of them could see the other against. A cap
     * that only holds when requests happen to be sequential is not a cap.
     *
     * Not stamped when escalating: `APPROVED_BY_SHOP` is a request for an admin
     * to decide, and nothing has been resolved. It is excluded from the counted
     * statuses above for the same reason.
     *
     * `settleClaimedRefund` still writes it on success, moving it forward by the
     * gateway round trip. Both values land on the same IST day, which is the
     * only granularity anything here reads it at, and the earlier one is the
     * more honest answer to `reconcileStuckRefunds`'s question — "how long has
     * this attempt been in flight".
     */
    const attemptStartedAt = escalationReason ? {} : { adminResolvedAt: new Date() };

    // Take over an open claim if the student already raised one, so a shop
    // approving and a student requesting cannot produce two rows for one order
    // — `orderId` is unique, and a settled claim is never reopened.
    const claimed = await tx.refundRequest.updateMany({
      where: { orderId, status: { in: CLAIMABLE_STATUSES } },
      data: {
        status: nextStatus,
        shopResponse: reason,
        shopRespondedAt: new Date(),
        refundAmount: amount,
        ...attemptStartedAt,
      },
    });

    if (claimed.count === 0) {
      const existing = await tx.refundRequest.findUnique({ where: { orderId }, select: { id: true, status: true } });
      if (existing) {
        // Already settled or already in flight; nothing left to approve.
        throw ApiError.badRequest(`This refund is already ${existing.status.toLowerCase().replace(/_/g, ' ')}`);
      }
      const created = await tx.refundRequest.create({
        data: {
          orderId,
          studentId: order.userId,
          shopId: order.shopId,
          reason,
          shopResponse: reason,
          shopRespondedAt: new Date(),
          refundAmount: amount,
          status: nextStatus,
          ...attemptStartedAt,
        },
        select: { id: true },
      });
      requestId = created.id;
    } else {
      const row = await tx.refundRequest.findUnique({ where: { orderId }, select: { id: true } });
      requestId = row!.id;
    }
  });

  if (escalationReason) {
    notifyService.notifyAdmins(
      `Refund of ₹${(amount / 100).toFixed(2)} on order ${orderId} needs your approval — ${escalationReason}.`,
      'warning'
    );
    return { settled: false, escalationReason, amount };
  }

  // Outside the transaction: this calls Razorpay, and a network round trip must
  // never be made while holding database locks.
  await settleClaimedRefund(requestId, {
    setOrderRefunded: true,
    createdBy: 'SYSTEM',
    resolvedBy: shopOwnerUserId,
    adminNote: `Approved by shop: ${reason}`,
  });

  // Told, not asked. Removing the approval gate is only safe if abuse is
  // visible as it happens rather than discovered in the ledger later.
  notifyService.notifyAdmins(
    `Shop refunded ₹${(amount / 100).toFixed(2)} on order ${orderId} under its own limit.`,
    'info'
  );

  return { settled: true, amount };
}
