import { LedgerEntryType, LedgerEntryStatus } from '../types';

/**
 * Summaries a shop reads about its own money.
 *
 * These live outside the dashboard component so the tests can exercise the
 * figure the shop actually sees. The previous test copied this arithmetic into
 * its own file and asserted against the copy, which passes forever regardless
 * of what the dashboard goes on to do — the one thing a test about a
 * money figure must not do.
 */

/** Entry shape these summaries need. Anything wider is fine. */
export interface SummarisableEntry {
  type: LedgerEntryType;
  status: LedgerEntryStatus;
  amount: number;
  createdAt: string;
}

/** Movements that take back money the shop was previously credited. */
const CLAWBACK_TYPES: LedgerEntryType[] = [
  LedgerEntryType.REFUND_DEDUCTION,
  LedgerEntryType.CLAWBACK,
];

/**
 * What today actually earned, after anything taken back today.
 *
 * This once summed ORDER_EARNING alone, so an order earned and then refunded on
 * the same day still counted in full — the shop read a number it was never
 * going to be paid, while "Where your money is" showed the truth one card
 * below. Two figures on one screen disagreeing about money is worse than either
 * being absent, because it makes a shop owner distrust the one that is correct.
 *
 * Clamped at zero rather than shown negative: a clawback for an order earned on
 * an earlier day would otherwise make "Today's Earnings" read as a loss, which
 * is not what the card is answering. The balance panel is where a negative
 * movement belongs, and it reports it.
 *
 * `todayStartIso` must come from `startOfTodayIST` — the server draws every
 * money boundary at midnight IST, and a window drawn anywhere else covers a
 * different set of entries than the balances shown beside it.
 */
export function sumTodayEarnings(
  entries: SummarisableEntry[],
  todayStartIso: string
): number {
  const today = entries.filter(
    (entry) =>
      entry.status !== LedgerEntryStatus.VOID &&
      entry.amount > 0 &&
      entry.createdAt >= todayStartIso
  );

  const earned = today
    .filter((entry) => entry.type === LedgerEntryType.ORDER_EARNING)
    .reduce((sum, entry) => sum + entry.amount, 0);

  const takenBack = today
    .filter((entry) => CLAWBACK_TYPES.includes(entry.type))
    .reduce((sum, entry) => sum + entry.amount, 0);

  return Math.max(0, earned - takenBack);
}
