import { describe, test, expect } from 'vitest';
import { LedgerEntryType, LedgerEntryStatus } from '../../types';

/**
 * "Today's Earnings" against the shop's own ledger.
 *
 * The card summed ORDER_EARNING alone, so an order earned and then refunded on
 * the same day still counted in full. TestShop read "Today's Earnings ₹5" while
 * "Where your money is" — one card below, from the authoritative balance
 * columns — showed ₹0 across every bucket. The ledger was right both times; the
 * card was answering a different question than it claimed to.
 *
 * Two figures on one screen disagreeing about money is worse than either being
 * absent, because it makes a shop owner distrust the one that is correct.
 */

interface Entry {
  type: LedgerEntryType;
  status: LedgerEntryStatus;
  amount: number;
  createdAt: string;
}

/** Mirrors the memo in ShopDashboard. */
function todayEarnings(entries: Entry[], todayStartIso: string): number {
  const CLAWBACK_TYPES: LedgerEntryType[] = [
    LedgerEntryType.REFUND_DEDUCTION,
    LedgerEntryType.CLAWBACK,
  ];

  const today = entries.filter(e =>
    e.status !== LedgerEntryStatus.VOID && e.amount > 0 && e.createdAt >= todayStartIso
  );

  const earned = today
    .filter(e => e.type === LedgerEntryType.ORDER_EARNING)
    .reduce((s, e) => s + e.amount, 0);

  const takenBack = today
    .filter(e => CLAWBACK_TYPES.includes(e.type))
    .reduce((s, e) => s + e.amount, 0);

  return Math.max(0, earned - takenBack);
}

const TODAY = '2026-08-01T18:30:00.000Z'; // local midnight IST, as the dashboard computes it

const entry = (over: Partial<Entry>): Entry => ({
  type: LedgerEntryType.ORDER_EARNING,
  status: LedgerEntryStatus.SETTLED,
  amount: 300,
  createdAt: '2026-08-02T04:21:00.000Z',
  ...over,
});

describe('TestShop’s actual ledger', () => {
  test('the ₹5 that disagreed with an all-zero balance panel is now ₹3', () => {
    // Verbatim from production: ₹2 earned at 19:17, clawed back at 19:38 when
    // the order was refunded, plus a ₹3 earning at 04:21.
    const entries = [
      entry({ amount: 200, status: LedgerEntryStatus.PENDING, createdAt: '2026-08-01T19:17:00.000Z' }),
      entry({ amount: 200, type: LedgerEntryType.REFUND_DEDUCTION, status: LedgerEntryStatus.PENDING, createdAt: '2026-08-01T19:38:00.000Z' }),
      entry({ amount: 300, createdAt: '2026-08-02T04:21:00.000Z' }),
    ];

    expect(todayEarnings(entries, TODAY)).toBe(300);
  });
});

describe('Refunds are netted, not ignored', () => {
  test('an order earned and refunded the same day nets to nothing', () => {
    const entries = [
      entry({ amount: 500 }),
      entry({ amount: 500, type: LedgerEntryType.REFUND_DEDUCTION }),
    ];

    expect(todayEarnings(entries, TODAY)).toBe(0);
  });

  test('a CLAWBACK counts against the day too', () => {
    const entries = [
      entry({ amount: 800 }),
      entry({ amount: 300, type: LedgerEntryType.CLAWBACK }),
    ];

    expect(todayEarnings(entries, TODAY)).toBe(500);
  });

  test('a payout is not a clawback — moving money out is not un-earning it', () => {
    // Withdrawing today's earnings must not zero the day's earnings.
    const entries = [
      entry({ amount: 600 }),
      entry({ amount: 600, type: LedgerEntryType.PAYOUT }),
    ];

    expect(todayEarnings(entries, TODAY)).toBe(600);
  });
});

describe('Boundaries', () => {
  test('yesterday’s earning is excluded', () => {
    expect(todayEarnings([entry({ createdAt: '2026-08-01T10:00:00.000Z' })], TODAY)).toBe(0);
  });

  test('an entry exactly at the day boundary is included', () => {
    expect(todayEarnings([entry({ createdAt: TODAY })], TODAY)).toBe(300);
  });

  test('VOID entries are ignored on both sides', () => {
    const entries = [
      entry({ amount: 400 }),
      entry({ amount: 400, type: LedgerEntryType.REFUND_DEDUCTION, status: LedgerEntryStatus.VOID }),
    ];

    expect(todayEarnings(entries, TODAY)).toBe(400);
  });

  test('a clawback for an earlier day never shows as negative earnings', () => {
    // The card answers "what did today earn", so a loss belongs in the balance
    // panel, not here — and a negative reads as a bug to a shop owner.
    const entries = [entry({ amount: 900, type: LedgerEntryType.REFUND_DEDUCTION })];

    expect(todayEarnings(entries, TODAY)).toBe(0);
  });

  test('a shop with no ledger activity shows nothing rather than NaN', () => {
    expect(todayEarnings([], TODAY)).toBe(0);
  });
});
