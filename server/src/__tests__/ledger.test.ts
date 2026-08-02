/**
 * Unit Tests — Ledger balance movement and settlement timing.
 *
 * These cover the pure logic that decides how money redistributes across a
 * shop's balances and when earnings become withdrawable. Both are the parts
 * that would silently lose or invent money if they were wrong.
 */

import { computeBalanceMovement, shopShareOfRefund } from '../services/ledger.service';
import { computeAvailableAt } from '../services/settlement.service';
import { env } from '../config/env';

/** A shop with no money anywhere. Amounts are paise. */
const empty = { pendingBalance: 0, ledgerBalance: 0, debtAmount: 0 };

describe('Balance movement', () => {
  describe('credits', () => {
    test('an order earning lands in clearing, not available', () => {
      const move = computeBalanceMovement('ORDER_EARNING', 5000, empty);
      expect(move).toEqual({ clearing: 5000, available: 0, debt: 0 });
    });

    test('a credit pays down outstanding debt before adding to a balance', () => {
      const shop = { ...empty, debtAmount: 2000 };
      const move = computeBalanceMovement('ORDER_EARNING', 5000, shop);
      expect(move.debt).toBe(-2000);      // debt cleared
      expect(move.clearing).toBe(3000);   // remainder credited
      expect(move.available).toBe(0);
    });

    test('a credit smaller than the debt clears part of it and credits nothing', () => {
      const shop = { ...empty, debtAmount: 8000 };
      const move = computeBalanceMovement('ORDER_EARNING', 5000, shop);
      expect(move.debt).toBe(-5000);
      expect(move.clearing).toBe(0);
    });

    test('a payout reversal returns money to available, where it came from', () => {
      const move = computeBalanceMovement('PAYOUT_CANCEL_REFUND', 5000, empty);
      expect(move).toEqual({ clearing: 0, available: 5000, debt: 0 });
    });
  });

  describe('debits', () => {
    test('a payout draws from available, leaving clearing untouched', () => {
      const shop = { pendingBalance: 3000, ledgerBalance: 5000, debtAmount: 0 };
      const move = computeBalanceMovement('PAYOUT', 4000, shop);
      expect(move.available).toBe(-4000);
      expect(move.clearing).toBe(0);
      expect(move.debt).toBe(0);
    });

    test('a payout larger than available spills into clearing', () => {
      const shop = { pendingBalance: 3000, ledgerBalance: 1000, debtAmount: 0 };
      const move = computeBalanceMovement('PAYOUT', 2500, shop);
      expect(move.available).toBe(-1000);  // drained first
      expect(move.clearing).toBe(-1500);   // remainder
      expect(move.debt).toBe(0);
    });

    test('a refund draws from clearing first', () => {
      const shop = { pendingBalance: 3000, ledgerBalance: 5000, debtAmount: 0 };
      const move = computeBalanceMovement('REFUND_DEDUCTION', 2000, shop);
      expect(move.clearing).toBe(-2000);
      expect(move.available).toBe(0);
    });

    test('a refund exceeding every balance becomes debt rather than a negative balance', () => {
      const shop = { pendingBalance: 1000, ledgerBalance: 500, debtAmount: 0 };
      const move = computeBalanceMovement('REFUND_DEDUCTION', 4000, shop);
      expect(move.clearing).toBe(-1000);
      expect(move.available).toBe(-500);
      expect(move.debt).toBe(2500);   // the shortfall stays visible and owed
    });

    test('a debit never drives a balance below zero', () => {
      const shop = { pendingBalance: 100, ledgerBalance: 200, debtAmount: 0 };
      const move = computeBalanceMovement('PAYOUT', 10_000, shop);
      expect(shop.pendingBalance + move.clearing).toBeGreaterThanOrEqual(0);
      expect(shop.ledgerBalance + move.available).toBeGreaterThanOrEqual(0);
    });
  });

  test('money is conserved: what leaves the balances equals what is owed', () => {
    const shop = { pendingBalance: 1200, ledgerBalance: 800, debtAmount: 0 };
    const amount = 5000;
    const move = computeBalanceMovement('REFUND_DEDUCTION', amount, shop);
    const drawn = -(move.clearing + move.available);
    expect(drawn + move.debt).toBe(amount);
  });
});

describe('Settlement timing', () => {
  test('earnings are released the configured number of days later, not hours', () => {
    // This asserted a minimum hour-hold, which T+1 deliberately drops: money
    // earned at 23:59 is available six hours later, and money earned a minute
    // after midnight waits thirty. The guarantee is the calendar day, not a
    // duration — see settlementTiming.test.ts for why compounding an
    // hour-delay with a fixed release hour created a cliff.
    const earned = new Date('2026-08-01T10:00:00Z');
    const availableAt = computeAvailableAt(earned);

    expect(availableAt.getTime()).toBeGreaterThan(earned.getTime());
    const daysApart = (availableAt.getTime() - earned.getTime()) / (24 * 60 * 60 * 1000);
    expect(daysApart).toBeLessThanOrEqual(env.SETTLEMENT_DELAY_DAYS + 1);
  });

  test('availability lands on the configured release hour in IST', () => {
    const availableAt = computeAvailableAt(new Date('2026-08-01T10:00:00Z'));
    // Read the UTC instant back as IST wall-clock time.
    const ist = new Date(availableAt.getTime() + 5.5 * 60 * 60 * 1000);
    expect(ist.getUTCHours()).toBe(env.SETTLEMENT_RELEASE_HOUR_IST);
    expect(ist.getUTCMinutes()).toBe(0);
  });

  test('two orders on the same day settle at the same moment', () => {
    // Predictability is the point: a shop owner should be told one time, not a
    // different rolling deadline per order.
    const morning = computeAvailableAt(new Date('2026-08-01T04:00:00Z'));
    const evening = computeAvailableAt(new Date('2026-08-01T11:00:00Z'));
    expect(morning.toISOString()).toBe(evening.toISOString());
  });

  test('the promised time is always in the future', () => {
    const now = new Date();
    expect(computeAvailableAt(now).getTime()).toBeGreaterThan(now.getTime());
  });
});

/**
 * A failed Razorpay refund must leave the shop exactly where it started.
 *
 * The reversal is a compensating ADJUSTMENT credit rather than a deletion, so
 * these check the pair sums to zero across all three balances — including the
 * case where the deduction pushed the shop into debt, which is where an
 * asymmetric reversal would quietly invent or destroy money.
 */
describe('Refund reversal (refund.failed)', () => {
  /** Apply a movement to a shop, as the ledger's updateMany would. */
  const apply = (
    shop: { pendingBalance: number; ledgerBalance: number; debtAmount: number },
    move: { clearing: number; available: number; debt: number }
  ) => ({
    pendingBalance: shop.pendingBalance + move.clearing,
    ledgerBalance: shop.ledgerBalance + move.available,
    debtAmount: shop.debtAmount + move.debt,
  });

  test('reversing a fully-covered refund restores the original balances', () => {
    const before = { pendingBalance: 10000, ledgerBalance: 5000, debtAmount: 0 };

    const afterRefund = apply(before, computeBalanceMovement('REFUND_DEDUCTION', 4000, before));
    expect(afterRefund).toEqual({ pendingBalance: 6000, ledgerBalance: 5000, debtAmount: 0 });

    const afterReversal = apply(afterRefund, computeBalanceMovement('ADJUSTMENT', 4000, afterRefund));
    expect(afterReversal).toEqual(before);
  });

  test('reversing a refund that created debt clears the debt exactly', () => {
    const before = { pendingBalance: 1000, ledgerBalance: 0, debtAmount: 0 };

    // 5000 owed against 1000 held: 1000 drains, 4000 becomes debt.
    const move = computeBalanceMovement('REFUND_DEDUCTION', 5000, before);
    expect(move).toEqual({ clearing: -1000, available: 0, debt: 4000 });

    const afterRefund = apply(before, move);
    expect(afterRefund).toEqual({ pendingBalance: 0, ledgerBalance: 0, debtAmount: 4000 });

    // The credit must pay the debt down first, then restore the balance.
    const afterReversal = apply(afterRefund, computeBalanceMovement('ADJUSTMENT', 5000, afterRefund));
    expect(afterReversal).toEqual(before);
  });

  test('reversal is exact when the refund drained both buckets into debt', () => {
    const before = { pendingBalance: 2000, ledgerBalance: 3000, debtAmount: 0 };

    const afterRefund = apply(before, computeBalanceMovement('REFUND_DEDUCTION', 8000, before));
    expect(afterRefund).toEqual({ pendingBalance: 0, ledgerBalance: 0, debtAmount: 3000 });

    const afterReversal = apply(afterRefund, computeBalanceMovement('ADJUSTMENT', 8000, afterRefund));
    expect(afterReversal.debtAmount).toBe(0);
    // Total value is conserved, though it re-lands in clearing rather than
    // split across the two buckets it came from.
    const total = (s: typeof before) => s.pendingBalance + s.ledgerBalance - s.debtAmount;
    expect(total(afterReversal)).toBe(total(before));
  });
});

/**
 * Who absorbs a refund.
 *
 * The student is refunded `totalPrice`, but the shop only ever received
 * `pageCost` — `baseFee` is the platform's commission. These pin the rule that
 * the platform absorbs its own fee instead of clawing it back from the shop.
 */
describe('Shop liability for a refund', () => {
  /** Minimal tx double exposing just the lookup shopShareOfRefund performs. */
  const txWithEarning = (amount: number | null) => ({
    ledgerEntry: {
      findUnique: async () => (amount === null ? null : { amount }),
    },
  });

  test('a full refund debits the shop only its earnings, not the base fee', async () => {
    // Real production order: page=300 + base=200 = total=500.
    const share = await shopShareOfRefund(txWithEarning(300), 'order-1', 500);
    expect(share).toBe(300);
  });

  test('a partial refund below the earning is borne entirely by the shop', async () => {
    const share = await shopShareOfRefund(txWithEarning(300), 'order-1', 200);
    expect(share).toBe(200);
  });

  test('an order refunded before completion never earned, so the shop owes nothing', async () => {
    // No `earn:<orderId>` entry exists — deducting here would invent debt
    // against a shop that was never paid.
    const share = await shopShareOfRefund(txWithEarning(null), 'order-1', 500);
    expect(share).toBe(0);
  });
});
