import { describe, test, expect } from 'vitest';
import { sortNotificationsNewestFirst } from './notificationOrder';

/**
 * The ordering that lets the boundary schema stop inventing timestamps.
 *
 * A comparator built on `new Date(x).getTime()` returns NaN for an absent
 * date, and NaN makes every comparison false — which a sort reads as "these
 * are equal". One untimed row was therefore enough to leave the rest of the
 * tray in an arbitrary order, quietly. Avoiding that is why the schema used to
 * stamp missing times with the Unix epoch, and that default is what made every
 * server notification display as "56y ago".
 */
describe('sortNotificationsNewestFirst', () => {
  const at = (timestamp?: string, id = timestamp ?? 'none') => ({ id, timestamp });

  test('orders newest first', () => {
    const sorted = sortNotificationsNewestFirst([
      at('2026-08-01T00:00:00.000Z'),
      at('2026-08-03T00:00:00.000Z'),
      at('2026-08-02T00:00:00.000Z'),
    ]);

    expect(sorted.map((n) => n.id)).toEqual([
      '2026-08-03T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    ]);
  });

  test('an untimed notification does not disturb the order of the timed ones', () => {
    // The real failure: with a NaN comparator the untimed row reads as equal
    // to everything, so the timed rows either side of it stop being ordered
    // relative to each other.
    const sorted = sortNotificationsNewestFirst([
      at('2026-08-01T00:00:00.000Z', 'oldest'),
      at(undefined, 'untimed'),
      at('2026-08-03T00:00:00.000Z', 'newest'),
      at('2026-08-02T00:00:00.000Z', 'middle'),
    ]);

    expect(sorted.map((n) => n.id)).toEqual(['newest', 'middle', 'oldest', 'untimed']);
  });

  test('untimed notifications sort last, together', () => {
    const sorted = sortNotificationsNewestFirst([
      at(undefined, 'a'),
      at('2026-08-02T00:00:00.000Z', 'timed'),
      at(undefined, 'b'),
    ]);

    expect(sorted.map((n) => n.id)).toEqual(['timed', 'a', 'b']);
  });

  test('an unparseable timestamp is treated as absent, not as 1970', () => {
    // `new Date("yesterday")` is Invalid Date. Sorting it as epoch would bury
    // a real notification at the bottom of the tray; treating it as untimed
    // puts it with the others whose time we simply do not know.
    const sorted = sortNotificationsNewestFirst([
      at('not a date', 'junk'),
      at('2026-08-02T00:00:00.000Z', 'timed'),
    ]);

    expect(sorted.map((n) => n.id)).toEqual(['timed', 'junk']);
  });

  test('does not mutate its input', () => {
    const input = [at('2026-08-01T00:00:00.000Z', 'a'), at('2026-08-03T00:00:00.000Z', 'b')];
    sortNotificationsNewestFirst(input);

    expect(input.map((n) => n.id)).toEqual(['a', 'b']);
  });
});
