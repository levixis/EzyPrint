/**
 * Shop-initiated refunds — the velocity limits that replace admin approval.
 *
 * A refund returns money to whoever paid, so a shop approving one cannot profit
 * from it; the worst an abused account achieves is handing that shop's own
 * earnings back to real customers. Gating every refund on an admin costs a
 * student a wait on one person and buys little. These limits bound the damage
 * instead, which is what payment processors do.
 *
 * Over a limit the claim escalates, never disappears — a refund lost because a
 * shop hit its daily cap is worse than a slow one.
 */

import { shopRefundEscalationReason } from '../services/refund.service';
import { env } from '../config/env';

const PER_REFUND = env.SHOP_REFUND_MAX_PER_REFUND_PAISE;
const PER_DAY_COUNT = env.SHOP_REFUND_MAX_PER_DAY_COUNT;
const PER_DAY_VALUE = env.SHOP_REFUND_MAX_PER_DAY_PAISE;

const check = (amount: number, countToday = 0, valueToday = 0) =>
  shopRefundEscalationReason({ amount, countToday, valueToday });

describe('An ordinary refund needs nobody', () => {
  test('a typical print order settles on the shop’s own authority', () => {
    // ₹200 — well inside every limit.
    expect(check(20_000)).toBeUndefined();
  });

  test('a refund exactly at the per-refund ceiling is allowed', () => {
    // Boundaries are where money bugs live: > not >=.
    expect(check(PER_REFUND)).toBeUndefined();
  });

  test('a free order is not special-cased into an escalation', () => {
    expect(check(0)).toBeUndefined();
  });
});

describe('Per-refund ceiling', () => {
  test('one paisa over needs an admin', () => {
    expect(check(PER_REFUND + 1)).toMatch(/admin approval/);
  });

  test('the message names the actual limit in rupees', () => {
    // The shop owner reads this, and paise in an error message means nothing
    // to them.
    expect(check(PER_REFUND + 1)).toContain(String(PER_REFUND / 100));
  });
});

describe('Daily count cap', () => {
  test('the last refund inside the cap still goes through', () => {
    expect(check(1_000, PER_DAY_COUNT - 1)).toBeUndefined();
  });

  test('the one after the cap escalates', () => {
    // >= not >: at N already settled, the next is the N+1th.
    expect(check(1_000, PER_DAY_COUNT)).toMatch(/Daily limit/);
  });
});

describe('Daily value cap', () => {
  test('a refund that exactly reaches the ceiling is allowed', () => {
    expect(check(5_000, 1, PER_DAY_VALUE - 5_000)).toBeUndefined();
  });

  test('a refund that would cross the ceiling escalates', () => {
    // The refund about to be made counts toward the total; checking only what
    // has already gone out would let the last one of the day be unbounded.
    expect(check(5_001, 1, PER_DAY_VALUE - 5_000)).toMatch(/Daily refund total/);
  });

  test('a single large refund is caught by the per-refund cap first', () => {
    // Both limits apply; the message should name the one the shop can act on.
    expect(check(PER_DAY_VALUE + 1)).toMatch(/admin approval/);
  });
});

describe('The limits are ordered so the message is useful', () => {
  test('an over-cap refund on an already-busy day cites the amount, not the count', () => {
    const reason = check(PER_REFUND + 1, PER_DAY_COUNT, PER_DAY_VALUE);
    // Telling a shop "daily limit reached" when the real problem is that this
    // single refund is too large sends them to wait until tomorrow for nothing.
    expect(reason).toMatch(/admin approval/);
  });
});

/**
 * The defaults ship as policy, so they are worth asserting rather than leaving
 * to whatever an env var happens to say.
 */
describe('Shipped defaults', () => {
  test('a shop can settle an ordinary campus refund without an admin', () => {
    // Orders here are pages at ₹1-3 and a ₹49 pass; ₹500 covers essentially
    // every genuine refund.
    expect(PER_REFUND).toBeGreaterThanOrEqual(50_000);
  });

  test('a compromised account is bounded to a recoverable amount per day', () => {
    expect(PER_DAY_VALUE).toBeLessThanOrEqual(500_000);
    expect(PER_DAY_COUNT).toBeLessThanOrEqual(25);
  });
});
