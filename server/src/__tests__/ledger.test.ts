/**
 * Unit Tests — Ledger balance movement and settlement timing.
 *
 * These cover the pure logic that decides how money redistributes across a
 * shop's balances and when earnings become withdrawable. Both are the parts
 * that would silently lose or invent money if they were wrong.
 */

import { computeBalanceMovement } from '../services/ledger.service';
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
  test('earnings are never available before the configured delay', () => {
    const now = new Date('2026-08-01T10:00:00Z');
    const availableAt = computeAvailableAt(now);
    const delayMs = env.SETTLEMENT_DELAY_HOURS * 60 * 60 * 1000;
    expect(availableAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + delayMs);
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
