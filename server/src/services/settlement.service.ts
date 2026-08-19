import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { env } from '../config/env';
import { createLedgerEntry } from './ledger.service';
import { enqueueShopEvent, publishQueued } from './realtime.service';

/**
 * Settlement — how a shop's earnings mature into withdrawable money.
 *
 * Money moves through four visible stages:
 *
 *   in progress → clearing → available → paid out
 *
 * A student's payment sits in "in progress" (derived from live orders) until
 * the shop fulfils the order. On COMPLETED the shop is credited: an
 * ORDER_EARNING entry lands in "clearing" carrying an `availableAt` stamped at
 * write time. The sweep below moves entries into "available" once that moment
 * passes.
 *
 * Stamping `availableAt` up front is deliberate. The dashboard can then promise
 * an exact time ("available Thursday, 6:00 AM") the instant the money is
 * earned, instead of showing an opaque rolling window and leaving the owner to
 * guess. Predictability is the thing partner dashboards consistently get asked
 * for, and the sweep becomes a trivial `availableAt <= now` query.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30 year-round, no DST.

/**
 * When money earned at `from` becomes withdrawable: the release hour, N days
 * after the day it was earned. T+1 by default, the settlement language every
 * payment provider already uses.
 *
 * This deliberately does not add a fixed number of hours and then round up to
 * the release hour. Doing both compounds them and puts a cliff at
 * (release hour − delay): with a 24-hour hold, work finished at 05:59 cleared
 * the next morning and work finished at 06:01 waited a further full day. Two
 * minutes apart, double the wait, and nothing on the dashboard explaining it —
 * with afternoon shops, which is most of them, always on the wrong side.
 * Shortening the hold only moves the cliff to a different hour.
 *
 * Keyed on the IST calendar day, so the boundary is midnight — the one place a
 * shop owner already expects one. "Everything you earn today is available
 * tomorrow at 6" is a sentence that needs no further explanation, and it holds
 * whatever time the order was completed.
 */
export function computeAvailableAt(from: Date = new Date()): Date {
  // Shift into IST so both "which day" and "6 AM" mean what the shops mean.
  const ist = new Date(from.getTime() + IST_OFFSET_MS);

  return new Date(
    Date.UTC(
      ist.getUTCFullYear(),
      ist.getUTCMonth(),
      ist.getUTCDate() + env.SETTLEMENT_DELAY_DAYS,
      env.SETTLEMENT_RELEASE_HOUR_IST,
      0, 0, 0
    ) - IST_OFFSET_MS
  );
}

/**
 * Credit a shop for a fulfilled order.
 *
 * The shop earns the page cost; the platform keeps the base fee.
 *
 * Idempotency is structural, not checked-then-acted: `eventId` is a
 * deterministic `earn:<orderId>` and `LedgerEntry.eventId` carries a unique
 * constraint. Two concurrent completions — or a webhook redelivery racing a
 * manual transition — cannot both credit, because the second insert violates
 * the constraint inside its own transaction and rolls back. There is no window
 * between a check and a write for a duplicate to slip through.
 *
 * Must be called with the transaction that moved the order to COMPLETED, so the
 * credit and the status change commit or fail together.
 */
export async function creditOrderEarning(
  tx: Prisma.TransactionClient,
  order: { id: string; shopId: string; pageCost: number },
  /**
   * When the money was earned. Defaults to now, which is right for the live
   * path where this runs inside the completion itself.
   *
   * A backfill passes the order's actual completion time instead. Otherwise
   * work finished last week would be scheduled to clear tomorrow, and the shop
   * would wait out our delay on top of its own.
   */
  earnedAt: Date = new Date()
): Promise<void> {
  if (order.pageCost <= 0) return;

  await createLedgerEntry(
    {
      shopId: order.shopId,
      type: 'ORDER_EARNING',
      amount: order.pageCost,
      description: `Earnings for order #${order.id.slice(-6)}`,
      counterparty: 'STUDENT',
      createdBy: 'SYSTEM',
      orderId: order.id,
      eventId: `earn:${order.id}`,
      availableAt: computeAvailableAt(earnedAt),
    },
    tx
  );
}

export interface SweepResult {
  shopsSettled: number;
  entriesSettled: number;
  amountSettled: number;
}

/**
 * Move matured earnings from clearing into available.
 *
 * Runs per shop in its own transaction so one shop's concurrent-update conflict
 * cannot roll back every other shop's settlement.
 */
export async function runSettlementSweep(now: Date = new Date()): Promise<SweepResult> {
  const due = await prisma.ledgerEntry.groupBy({
    by: ['shopId'],
    // Same predicate `settleShop` uses, so this cannot select a shop that then
    // turns out to have nothing settleable.
    where: { status: 'PENDING', type: 'ORDER_EARNING', availableAt: { not: null, lte: now } },
    _sum: { amount: true },
    _count: { _all: true },
  });

  const result: SweepResult = { shopsSettled: 0, entriesSettled: 0, amountSettled: 0 };

  for (const group of due) {
    try {
      const settled = await settleShop(group.shopId, now);
      if (settled.entries > 0) {
        result.shopsSettled += 1;
        result.entriesSettled += settled.entries;
        result.amountSettled += settled.amount;
      }
    } catch (error) {
      // One shop failing must not abort the run; the next sweep retries it.
      console.error(`[settlement] shop ${group.shopId} failed to settle:`, error);
    }
  }

  return result;
}

async function settleShop(shopId: string, now: Date): Promise<{ entries: number; amount: number }> {
  const outboxIds: string[] = [];

  const outcome = await prisma.$transaction(async (tx) => {
    const shop = await tx.shop.findUnique({ where: { id: shopId } });
    if (!shop) return { entries: 0, amount: 0 };

    // Narrowed to earnings in the query rather than filtered after it.
    //
    // Only earnings mature into withdrawable money — a PENDING payout
    // reservation also lives in this table and must not be swept into the
    // shop's available balance. Selecting everything and filtering afterwards
    // meant any non-earning entry carrying a matured `availableAt` was picked
    // up on every sweep and never marked, so it stayed PENDING with a past
    // `availableAt` forever. `buildBalanceSnapshot` reads the earliest such
    // entry as `nextSettlementAt`, so the shop's dashboard would have promised
    // a settlement date in the past, permanently.
    const earnings = await tx.ledgerEntry.findMany({
      where: { shopId, status: 'PENDING', type: 'ORDER_EARNING', availableAt: { not: null, lte: now } },
      select: { id: true, amount: true },
    });
    if (earnings.length === 0) return { entries: 0, amount: 0 };

    const total = earnings.reduce((sum, e) => sum + e.amount, 0);

    // Never move more than is actually sitting in clearing — a refund may have
    // drawn it down since these entries were written.
    const movable = Math.min(total, shop.pendingBalance);

    const marked = await tx.ledgerEntry.updateMany({
      where: { id: { in: earnings.map(e => e.id) }, status: 'PENDING' },
      data: { status: 'SETTLED', settledAt: now },
    });
    if (marked.count === 0) return { entries: 0, amount: 0 };

    // Same compare-and-swap the ledger uses, so a settlement cannot race a
    // payout or refund landing at the same moment.
    const updated = await tx.shop.updateMany({
      where: {
        id: shopId,
        financialVersion: shop.financialVersion,
        pendingBalance: { gte: movable },
      },
      data: {
        pendingBalance: { decrement: movable },
        ledgerBalance: { increment: movable },
        lastSettlementAt: now,
        financialVersion: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      // Roll back by throwing — the entries must not stay marked SETTLED if the
      // money did not move.
      throw new Error('Concurrent balance update during settlement');
    }

    const outboxId = await enqueueShopEvent(tx, {
      shopId,
      type: 'ledger.settled',
      seq: shop.financialVersion + 1,
      data: {
        settledEntryIds: earnings.map(e => e.id),
        amount: movable,
        balances: {
          clearing: shop.pendingBalance - movable,
          available: shop.ledgerBalance + movable,
          debt: shop.debtAmount,
        },
      },
    });
    outboxIds.push(outboxId);

    return { entries: marked.count, amount: movable };
  });

  await publishQueued(outboxIds);
  return outcome;
}
