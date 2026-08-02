/**
 * Date formatting that cannot render "Invalid Date".
 *
 * `new Date(undefined).toLocaleString()` returns the literal string "Invalid
 * Date", which React renders happily — so a field the server never sent shows
 * up in the UI as those two words rather than as an error anyone would notice
 * in testing. That is exactly how a ticket message came to be timestamped
 * "Invalid Date" in production.
 *
 * These take unknown input because that is what a network response is.
 */

/** Parse anything into a Date, or null when it isn't one. */
export function toDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Format a timestamp for display, falling back rather than lying.
 *
 * The fallback is empty by default: a missing timestamp should leave a gap,
 * not assert something false about when a thing happened.
 */
export function formatDateTime(value: unknown, fallback = ''): string {
  const date = toDate(value);
  return date ? date.toLocaleString() : fallback;
}

/** Date only, no time of day. */
export function formatDate(value: unknown, fallback = ''): string {
  const date = toDate(value);
  return date ? date.toLocaleDateString() : fallback;
}

// ─────────────────────────────────────────────────────────────
// THE MONEY DAY
//
// Every boundary the server draws around money is midnight IST: settlement
// (`settlement.service.computeAvailableAt`), the shop's daily refund cap
// (`refund.service.startOfDayIST`). Anything on this side that summarises the
// same money has to draw it in the same place, or the two disagree by up to a
// day and the shop sees a figure the ledger will not back up.
//
// Device-local midnight is not the same boundary. It is only equal on a device
// set to IST, which is most of them and therefore the reason this kind of bug
// survives testing.
// ─────────────────────────────────────────────────────────────

/** IST is UTC+5:30 year-round, no DST. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The instant today began in IST.
 *
 * Deliberately the same computation as `startOfDayIST` on the server, so a
 * figure summed against this window covers exactly the entries the server
 * considers to be today's.
 */
export function startOfTodayIST(now: Date = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

/**
 * How long until the IST day rolls over.
 *
 * A print shop leaves its dashboard open all day, so "today" cannot be decided
 * once at mount and kept — it has to be re-derived when the day actually
 * changes, or the card keeps reporting a window that closed hours ago.
 */
export function msUntilNextIstMidnight(now: Date = new Date()): number {
  const nextMidnight = startOfTodayIST(now).getTime() + 24 * 60 * 60 * 1000;
  return Math.max(0, nextMidnight - now.getTime());
}
