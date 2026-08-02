import { describe, test, expect } from 'vitest';
import { LedgerEntryType, LedgerEntryStatus } from '../../types';
import { sumTodayEarnings, type SummarisableEntry } from '../../utils/ledgerSummary';
import { startOfTodayIST, msUntilNextIstMidnight } from '../../utils/datetime';

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

type Entry = SummarisableEntry;

/**
 * The function the dashboard actually calls.
 *
 * This test used to hold its own copy of the arithmetic and assert against
 * that, which passes forever no matter what the dashboard goes on to do. A
 * test about a money figure has to exercise the figure the shop sees.
 */
const todayEarnings = sumTodayEarnings;

const TODAY = '2026-08-01T18:30:00.000Z'; // midnight IST on 2 Aug, which is 18:30 UTC on 1 Aug

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

/**
 * Where the day is drawn — the input the sum above trusts completely.
 *
 * The dashboard used to compute this as `new Date(y, m, d)`, which is midnight
 * wherever the device happens to be. Every money boundary the server draws is
 * midnight IST, so on any device not set to IST the card summed a window up to
 * a day out of step with the balances printed directly beneath it. On an IST
 * device the two are identical, which is exactly why nobody caught it.
 */
describe('The day is drawn at midnight IST, not on the device', () => {
  test('an afternoon IST timestamp belongs to that IST day', () => {
    // 09:51 IST on 2 Aug → the day began at 18:30 UTC on 1 Aug.
    const start = startOfTodayIST(new Date('2026-08-02T04:21:00.000Z'));
    expect(start.toISOString()).toBe('2026-08-01T18:30:00.000Z');
  });

  test('just before IST midnight still belongs to the old day', () => {
    // 23:59 IST on 2 Aug is 18:29 UTC on 2 Aug.
    const start = startOfTodayIST(new Date('2026-08-02T18:29:00.000Z'));
    expect(start.toISOString()).toBe('2026-08-01T18:30:00.000Z');
  });

  test('just after IST midnight begins the new day', () => {
    const start = startOfTodayIST(new Date('2026-08-02T18:31:00.000Z'));
    expect(start.toISOString()).toBe('2026-08-02T18:30:00.000Z');
  });

  test('the boundary does not move with the device timezone', () => {
    // The same instant, whatever the host is set to — this is a pure
    // computation on epoch milliseconds, with no local-time call in it.
    const instant = new Date('2026-08-02T04:21:00.000Z');
    expect(startOfTodayIST(instant).getTime()).toBe(Date.parse('2026-08-01T18:30:00.000Z'));
  });

  test('an entry timestamped between UTC and IST midnight counts as today', () => {
    // 19:17 UTC on 1 Aug is 00:47 IST on 2 Aug. Under a UTC-drawn boundary this
    // entry falls on the previous day and vanishes from the card; under the IST
    // boundary it is today's, which is what the ledger settles it as.
    const start = startOfTodayIST(new Date('2026-08-02T04:21:00.000Z')).toISOString();
    expect(todayEarnings([entry({ createdAt: '2026-08-01T19:17:00.000Z' })], start)).toBe(300);
  });
});

/**
 * Rolling over.
 *
 * `todayStart` was a `useMemo` with no dependencies, so it was fixed at mount.
 * A print shop leaves this screen open all day; at 00:01 the card was still
 * summing yesterday and stayed that way until someone reloaded the page.
 */
describe('The window re-arms at the next IST midnight', () => {
  test('counts down to the coming midnight, not a fixed 24 hours', () => {
    // 23:00 IST → one hour left in the day.
    const ms = msUntilNextIstMidnight(new Date('2026-08-02T17:30:00.000Z'));
    expect(ms).toBe(60 * 60 * 1000);
  });

  test('a moment after midnight waits nearly a full day', () => {
    const ms = msUntilNextIstMidnight(new Date('2026-08-02T18:31:00.000Z'));
    expect(ms).toBe(24 * 60 * 60 * 1000 - 60 * 1000);
  });

  test('never returns a negative delay, which would fire a timer in a loop', () => {
    expect(msUntilNextIstMidnight(new Date('2026-08-02T18:30:00.000Z'))).toBeGreaterThan(0);
  });
});
