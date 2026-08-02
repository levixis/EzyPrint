/**
 * When earnings become withdrawable.
 *
 * The rule is T+1: everything earned on a day is released at the release hour
 * the next morning. It is counted in days rather than hours deliberately.
 *
 * Adding a fixed hour-delay and then rounding up to a fixed release hour
 * compounds the two and leaves a cliff at (release hour − delay). With a
 * 24-hour hold, work finished at 05:59 cleared next morning and work finished
 * at 06:01 waited a further full day — two minutes apart, double the wait, and
 * afternoon shops always on the wrong side of it. Shortening the hold only
 * moves the cliff to another hour; counting days puts the boundary at midnight,
 * the one place a shop owner already expects one.
 */

import { computeAvailableAt } from '../services/settlement.service';
import { env } from '../config/env';

const IST = 5.5 * 60 * 60 * 1000;

/** A Date for the given IST wall-clock time. */
const at = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 7, day, hour, minute) - IST);

/** The IST wall-clock reading of a Date, as "DD HH:MM". */
const istOf = (d: Date) => {
  const s = new Date(d.getTime() + IST);
  return `${s.getUTCDate()} ${String(s.getUTCHours()).padStart(2, '0')}:${String(s.getUTCMinutes()).padStart(2, '0')}`;
};

describe('Everything earned in a day clears the same next morning', () => {
  test.each([
    ['the first minute of the day', at(1, 0, 1)],
    ['just before the release hour', at(1, 5, 59)],
    ['just after the release hour', at(1, 6, 1)],
    ['mid-morning', at(1, 10, 36)],
    ['afternoon', at(1, 15, 0)],
    ['evening rush', at(1, 18, 1)],
    ['the last minute of the day', at(1, 23, 59)],
  ])('%s clears at 6am on the 2nd', (_label, earned) => {
    expect(istOf(computeAvailableAt(earned))).toBe('2 06:00');
  });
});

describe('No cliff at any hour', () => {
  test('no two consecutive minutes of a day settle more than a minute apart', () => {
    // The old rule failed this at 06:00 exactly, by a full day.
    let previous = computeAvailableAt(at(1, 0, 0)).getTime();
    for (let hour = 0; hour < 24; hour++) {
      for (const minute of [0, 1, 30, 59]) {
        const current = computeAvailableAt(at(1, hour, minute)).getTime();
        expect(Math.abs(current - previous)).toBeLessThanOrEqual(60_000);
        previous = current;
      }
    }
  });

  test('the boundary is midnight, and it moves settlement by exactly one day', () => {
    const lastMinute = computeAvailableAt(at(1, 23, 59));
    const firstMinute = computeAvailableAt(at(2, 0, 1));
    expect((firstMinute.getTime() - lastMinute.getTime()) / 3_600_000).toBe(24);
  });
});

describe('Guarantees the dashboard depends on', () => {
  test('release always lands exactly on the configured hour', () => {
    for (let hour = 0; hour < 24; hour++) {
      const ist = new Date(computeAvailableAt(at(1, hour)).getTime() + IST);
      expect(ist.getUTCHours()).toBe(env.SETTLEMENT_RELEASE_HOUR_IST);
      expect(ist.getUTCMinutes()).toBe(0);
      expect(ist.getUTCSeconds()).toBe(0);
    }
  });

  test('money is never available before it was earned', () => {
    for (let hour = 0; hour < 24; hour++) {
      const earned = at(1, hour);
      expect(computeAvailableAt(earned).getTime()).toBeGreaterThan(earned.getTime());
    }
  });

  test('the wait is never longer than T+1 plus a day', () => {
    for (let hour = 0; hour < 24; hour++) {
      const earned = at(1, hour);
      const waited = (computeAvailableAt(earned).getTime() - earned.getTime()) / 3_600_000;
      expect(waited).toBeLessThanOrEqual(env.SETTLEMENT_DELAY_DAYS * 24 + 6);
    }
  });

  test('it survives a month boundary', () => {
    // Date.UTC rolls the month over; a hand-rolled +1 day would not.
    const earned = new Date(Date.UTC(2026, 7, 31, 20, 0) - IST);
    expect(istOf(computeAvailableAt(earned))).toBe('1 06:00');
  });
});
