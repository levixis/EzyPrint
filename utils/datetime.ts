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
