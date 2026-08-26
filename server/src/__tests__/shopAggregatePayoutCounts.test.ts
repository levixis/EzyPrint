/**
 * `pendingPayoutCount` counts payouts that are actually pending.
 *
 * It used to be the `_count` of the aggregate beside it, which selects
 * `PAID`, `IN_TRANSIT` and `CONFIRMED` to total what has been *sent*. Reusing
 * that count for a field named "pending" made it report very nearly the
 * opposite: a shop with everything settled and nothing outstanding read as its
 * busiest, and a shop with a queue of unpaid requests read as zero.
 *
 * The admin dashboard sums this across shops and adds a correctly-derived
 * count of `PENDING` rows to it, so the two halves of one figure disagreed
 * about what they were counting.
 */

const mockShopFindUnique = jest.fn();
const mockOrderGroupBy = jest.fn();
const mockPayoutAggregate = jest.fn();
const mockPayoutCount = jest.fn();
const mockAggregateUpsert = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    shop: { findUnique: mockShopFindUnique },
    order: { groupBy: mockOrderGroupBy },
    payout: { aggregate: mockPayoutAggregate, count: mockPayoutCount },
    shopAggregate: { upsert: mockAggregateUpsert },
  },
}));

import { getShopAggregate } from '../services/shop.service';

const OWNER = 'owner_1';

beforeEach(() => {
  jest.clearAllMocks();
  mockShopFindUnique.mockResolvedValue({
    id: 'shop_1',
    ownerUserId: OWNER,
    pendingBalance: 12_500,
  });
  mockOrderGroupBy.mockResolvedValue([]);
  // Four payouts have been sent, totalling ₹400.
  mockPayoutAggregate.mockResolvedValue({ _sum: { amount: 40_000 } });
  // One is still waiting on an admin.
  mockPayoutCount.mockResolvedValue(1);
  mockAggregateUpsert.mockImplementation(({ create }) => Promise.resolve(create));
});

/** What the service asked Prisma to store, on both branches of the upsert. */
const stored = () => mockAggregateUpsert.mock.calls[0][0];

describe('pendingPayoutCount', () => {
  test('is the number of PENDING payouts, not of sent ones', async () => {
    await getShopAggregate('shop_1', OWNER);

    const { create, update } = stored();
    expect(create.pendingPayoutCount).toBe(1);
    expect(update.pendingPayoutCount).toBe(1);
  });

  test('counts only PENDING rows', async () => {
    await getShopAggregate('shop_1', OWNER);

    expect(mockPayoutCount).toHaveBeenCalledWith({
      where: { shopId: 'shop_1', status: 'PENDING' },
    });
  });

  test('is zero for a shop whose payouts have all been sent', async () => {
    // The regression in its clearest form: this shop previously reported four.
    mockPayoutCount.mockResolvedValue(0);
    await getShopAggregate('shop_1', OWNER);

    expect(stored().create.pendingPayoutCount).toBe(0);
  });

  test('totalPaidOut still comes from the sent-payout sum', async () => {
    // The aggregate beside it is unchanged, and is what "Paid Out" reads —
    // splitting the count out must not have moved the money figure with it.
    await getShopAggregate('shop_1', OWNER);

    expect(stored().create.totalPaidOut).toBe(40_000);
    expect(mockPayoutAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: 'shop_1', status: { in: ['PAID', 'IN_TRANSIT', 'CONFIRMED'] } },
      })
    );
  });
});
