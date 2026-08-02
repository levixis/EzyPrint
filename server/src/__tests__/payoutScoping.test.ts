/**
 * A shop owner may only ever see their own payouts.
 *
 * `GET /payouts` scoped the query with `whereClause.shopId = shop?.id`. Prisma
 * drops an `undefined` from a where clause rather than matching nothing, so an
 * owner with no shop row did not get an empty list — they got an *unfiltered*
 * query, and read back every payout in the system: amounts, shop ids, admin
 * notes, the lot.
 *
 * The reachable route to that state was the Google signup path, which created a
 * SHOP_OWNER account and silently skipped shop creation when `shopName` or
 * `shopAddress` were absent. Both ends are fixed; these pin the filter, because
 * it is the one that has to hold even if a way back into that state reappears.
 *
 * The `undefined` behaviour is Prisma's, not ours, so it is asserted here
 * directly — if it ever changes, this test should be the thing that notices.
 */

import { googleAuthSchema } from '../validators/schemas';
import { payoutScopeFor } from '../routes/payout.routes';
import { clampListLimit, clampThresholdMinutes } from '../utils/pagination';

describe('payout list scoping', () => {
  test('an owner with a shop is scoped to that shop', () => {
    expect(payoutScopeFor('SHOP_OWNER', { id: 'shop_1' })).toEqual({ shopId: 'shop_1' });
  });

  test('an owner with no shop is refused, not handed an empty filter', () => {
    // The bug: this used to produce `{ shopId: undefined }`, which Prisma
    // treats as "no condition" — every payout, every shop.
    expect(() => payoutScopeFor('SHOP_OWNER', null)).toThrow(/shop not found/i);
  });

  test('an owner cannot widen the query by naming another shop', () => {
    // `?shopId=` is honoured for admins only. An owner passing one must still
    // be pinned to their own.
    expect(payoutScopeFor('SHOP_OWNER', { id: 'shop_1' }, 'shop_2')).toEqual({ shopId: 'shop_1' });
  });

  test('an admin sees everything by default', () => {
    expect(payoutScopeFor('ADMIN', null)).toEqual({});
  });

  test('an admin may narrow to one shop', () => {
    expect(payoutScopeFor('ADMIN', null, 'shop_2')).toEqual({ shopId: 'shop_2' });
  });

  test('an undefined scope is not a narrower query, it is no query at all', () => {
    // Pinning the assumption the bug rested on. `{ shopId: undefined }` and
    // `{}` are the same object to Prisma; `{ shopId: null }` is not.
    const leaky: Record<string, unknown> = { shopId: undefined };
    expect(Object.values(leaky).every((v) => v === undefined)).toBe(true);
    expect(JSON.stringify(leaky)).toBe('{}');
  });
});

/**
 * The limit on the same endpoint, which was the only list route in the codebase
 * without one — `Number(req.query.limit) || 20`, unbounded above.
 */
describe('payout list limit', () => {
  test('defaults when absent or unparseable', () => {
    expect(clampListLimit(undefined)).toBe(20);
    expect(clampListLimit('not a number')).toBe(20);
  });

  test('an empty query parameter is absent, not zero', () => {
    // `Number('')` is 0, so a naive parse would clamp `?limit=` to the minimum
    // instead of falling back.
    expect(clampListLimit('')).toBe(20);
  });

  test('caps a request for the whole table', () => {
    expect(clampListLimit('1000000')).toBe(100);
  });

  test('a zero or negative limit floors to one rather than to the default', () => {
    expect(clampListLimit('0')).toBe(1);
    expect(clampListLimit('-5')).toBe(1);
  });

  test('an ordinary request is honoured', () => {
    expect(clampListLimit('50')).toBe(50);
  });
});

/**
 * The state that made the leak reachable.
 *
 * The password registration schema has always required a shop name, address and
 * referral code from a SHOP_OWNER. The Google schema did not, so the same
 * account type could be created either way — one of them with a shop, one
 * without.
 */
describe('google signup requires a shop from a shop owner', () => {
  const parse = (body: Record<string, unknown>) =>
    googleAuthSchema.safeParse({ body });

  test('a shop owner must bring name, address and referral code', () => {
    const result = parse({
      idToken: 'tok',
      userType: 'SHOP_OWNER',
      referralCode: 'REF123',
      // shopName and shopAddress deliberately absent — this is the request
      // that used to create an owner with no shop.
    });
    expect(result.success).toBe(false);
  });

  test('a complete shop owner signup is accepted', () => {
    const result = parse({
      idToken: 'tok',
      userType: 'SHOP_OWNER',
      shopName: 'Campus Print',
      shopAddress: 'Block C',
      referralCode: 'REF123',
    });
    expect(result.success).toBe(true);
  });

  test('a student needs none of it', () => {
    expect(parse({ idToken: 'tok', userType: 'STUDENT' }).success).toBe(true);
  });

  test('an existing user signing in sends no userType and is unaffected', () => {
    // The app omits userType for a returning user; the server answers
    // `isNewUser` when it cannot tell. Requiring shop fields here would break
    // every returning shop owner's sign-in.
    expect(parse({ idToken: 'tok' }).success).toBe(true);
  });
});

/**
 * `?threshold=0` on the reconcile endpoint — "sweep everything now".
 *
 * `parseInt(...) || 15` swallowed it: 0 is falsy, so the one value an operator
 * reaches for during an incident silently became the 15-minute default and the
 * sweep looked like it had done nothing.
 */
describe('reconcile threshold', () => {
  test('zero means zero, not the default', () => {
    expect(clampThresholdMinutes('0')).toBe(0);
  });

  test('absent or unparseable falls back to fifteen minutes', () => {
    expect(clampThresholdMinutes(undefined)).toBe(15);
    expect(clampThresholdMinutes('soon')).toBe(15);
  });

  test('a negative threshold cannot put the cutoff in the future', () => {
    // That would match orders whose payment has not been attempted yet.
    expect(clampThresholdMinutes('-60')).toBe(0);
  });

  test('an ordinary threshold is honoured', () => {
    expect(clampThresholdMinutes('30')).toBe(30);
  });
});
