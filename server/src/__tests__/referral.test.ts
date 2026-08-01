/**
 * Unit tests — referral code retention and the single-use guard.
 *
 * A referral code is what authorises a stranger to register as a shop owner and
 * take real money, so two things have to hold no matter what else changes: a
 * spent code can never be redeemed twice, and the record of who was let in
 * survives everything short of a deliberate purge.
 */

const mockDeleteMany = jest.fn();
const mockUpdateMany = jest.fn();
const mockFindMany = jest.fn();
const mockCreate = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    referralCode: {
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      create: (...args: unknown[]) => mockCreate(...args),
    },
  },
}));

import {
  sweepExpiredReferralCodes,
  deleteReferralCode,
  listReferralCodes,
  EXPIRED_CODE_GRACE_DAYS,
} from '../services/referral.service';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Sweeping expired referral codes', () => {
  const whereOf = () => mockDeleteMany.mock.calls[0][0].where;

  test('only ever-unused codes are swept', async () => {
    mockDeleteMany.mockResolvedValue({ count: 3 });
    await sweepExpiredReferralCodes();

    // A redeemed code is the record of which admin authorised which shop owner.
    // Age is irrelevant to it.
    expect(whereOf().usedAt).toBeNull();
  });

  test('the guard is usedAt, not usedBy', async () => {
    mockDeleteMany.mockResolvedValue({ count: 0 });
    await sweepExpiredReferralCodes();

    // usedBy clears when the shop owner's account is deleted. Sweeping on it
    // would delete the audit record of exactly the accounts most worth having
    // a record of.
    expect(whereOf()).not.toHaveProperty('usedBy');
  });

  test('codes with no expiry are never swept', async () => {
    mockDeleteMany.mockResolvedValue({ count: 0 });
    await sweepExpiredReferralCodes();

    // `expiresAt` is nullable and null means "never expires", not "expired long
    // ago". A bare `lt` would be right in SQL but silent about the intent.
    expect(whereOf().expiresAt.not).toBeNull();
  });

  test('an expired code survives its grace period', async () => {
    mockDeleteMany.mockResolvedValue({ count: 0 });
    const before = Date.now();
    await sweepExpiredReferralCodes();

    const cutoff: Date = whereOf().expiresAt.lt;
    const daysBack = (before - cutoff.getTime()) / (24 * 60 * 60 * 1000);

    // Deleting at the moment of expiry would erase the evidence that a code was
    // issued and never taken up.
    expect(Math.round(daysBack)).toBe(EXPIRED_CODE_GRACE_DAYS);
  });

  test('reports how many it removed', async () => {
    mockDeleteMany.mockResolvedValue({ count: 7 });
    expect(await sweepExpiredReferralCodes()).toBe(7);
  });
});

describe('Deleting a referral code by hand', () => {
  test('a used code cannot be deleted', async () => {
    // deleteMany matching nothing is how the guard reports refusal — there is
    // no read-then-check that a concurrent redemption could slip between.
    mockDeleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteReferralCode('code_1')).rejects.toThrow(/already been used/);
  });

  test('the refusal is keyed on usedAt so a deleted owner does not unlock it', async () => {
    mockDeleteMany.mockResolvedValue({ count: 1 });
    await deleteReferralCode('code_1');

    const where = mockDeleteMany.mock.calls[0][0].where;
    expect(where.usedAt).toBeNull();
    expect(where).not.toHaveProperty('usedBy');
  });

  test('an unused code is removed', async () => {
    mockDeleteMany.mockResolvedValue({ count: 1 });
    await expect(deleteReferralCode('code_1')).resolves.toBe(true);
  });
});

describe('Listing referral codes', () => {
  test('resolves the names behind both user ids', async () => {
    mockFindMany.mockResolvedValue([]);
    await listReferralCodes();

    // Without these the list answers "was this used?" and not "who did we let
    // in?", which is the only reason to keep a spent code.
    const include = mockFindMany.mock.calls[0][0].include;
    expect(include.creator).toBeDefined();
    expect(include.user.select.shop).toBeDefined();
  });
});
