import { toDate } from './datetime';

/**
 * Ordering for the notification tray.
 *
 * Extracted from the merge in AppContext so a test can exercise the real
 * comparator rather than a copy of it that can drift.
 *
 * The reason it needs care: `new Date(undefined).getTime()` is NaN, and every
 * comparison involving NaN is false. A comparator that returns false for both
 * `a < b` and `a > b` tells the sort those items are equal, so one untimed
 * notification leaves the surrounding order partly arbitrary — silently, and
 * differently depending on where it happened to sit in the input.
 *
 * That hazard is why the boundary schema used to stamp every timeless
 * notification with the Unix epoch. It worked for sorting and was a disaster
 * for display: no server notification has ever carried a `timestamp` field
 * (the row calls it `createdAt`), so the default fired on all of them and the
 * tray read "56y ago". Handling the absence here is what lets the schema stop
 * inventing data.
 */
export function sortNotificationsNewestFirst<T extends { timestamp?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const at = toDate(a.timestamp)?.getTime();
    const bt = toDate(b.timestamp)?.getTime();
    // Untimed notifications sort last, together, rather than scattered.
    if (at === undefined && bt === undefined) return 0;
    if (at === undefined) return 1;
    if (bt === undefined) return -1;
    return bt - at;
  });
}
