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
const mockLedgerAggregate = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    shop: { findUnique: mockShopFindUnique },
    order: { groupBy: mockOrderGroupBy },
    payout: { aggregate: mockPayoutAggregate, count: mockPayoutCount },
    shopAggregate: { upsert: mockAggregateUpsert },
    // Revenue is now netted against what the ledger says was handed back, so
    // this suite has to answer for the ledger as well.
    ledgerEntry: { aggregate: mockLedgerAggregate },
  },
}));

import { getShopAggregate } from '../services/shop.service';

const OWNER = 'owner_1';

/** ₹400 sent, ₹75 still waiting on an admin. */
const SENT_PAISE = 40_000;
const PENDING_PAISE = 7_500;

beforeEach(() => {
  jest.clearAllMocks();
  mockShopFindUnique.mockResolvedValue({
    id: 'shop_1',
    ownerUserId: OWNER,
    pendingBalance: 12_500,
  });
  mockOrderGroupBy.mockResolvedValue([]);
  // Two aggregates over the same table, distinguished by what they select:
  // everything already sent, and everything still queued.
  mockPayoutAggregate.mockImplementation(({ where }: { where: { status: unknown } }) =>
    Promise.resolve({
      _sum: { amount: where.status === 'PENDING' ? PENDING_PAISE : SENT_PAISE },
    })
  );
  // One is still waiting on an admin.
  mockPayoutCount.mockResolvedValue(1);
  // No refunds unless a test says otherwise.
  mockLedgerAggregate.mockResolvedValue({ _sum: { amount: 0 } });
  mockAggregateUpsert.mockImplementation(({ create }) => Promise.resolve(create));
});

/** Answer the deduction aggregate with `deducted` and the reversal one with `reversed`. */
const withRefunds = (deducted: number, reversed = 0) => {
  mockLedgerAggregate.mockImplementation(({ where }: { where: { type: string } }) =>
    Promise.resolve({ _sum: { amount: where.type === 'REFUND_DEDUCTION' ? deducted : reversed } })
  );
};

/** One order group, as `order.groupBy` returns them. */
const group = (status: string, count: number, pageCost: number, baseFee = 0) => ({
  status,
  _count: count,
  _sum: { pageCost, baseFee, totalPrice: pageCost + baseFee },
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

describe('totalRevenue nets refunds off, rather than discarding the order', () => {
  test('a partial refund removes only what was actually given back', async () => {
    // One completed ₹500 order, ₹100 of it refunded. The order is no longer
    // promoted to REFUNDED for a partial (see settleClaimedRefund), so it is
    // still COMPLETED here — which the old status-exclusion could not see at all.
    mockOrderGroupBy.mockResolvedValue([group('COMPLETED', 1, 50_000)]);
    withRefunds(10_000);

    await getShopAggregate('shop_1', OWNER);

    expect(stored().create.totalRevenue).toBe(40_000);
  });

  test('a full refund nets to nothing rather than to a negative', async () => {
    mockOrderGroupBy.mockResolvedValue([group('REFUNDED', 1, 50_000)]);
    withRefunds(50_000);

    await getShopAggregate('shop_1', OWNER);

    expect(stored().create.totalRevenue).toBe(0);
  });

  test('a refund the gateway failed does not reduce revenue, because it was reversed', async () => {
    // `applyRefundFailed` writes a compensating ADJUSTMENT and returns the order
    // to COMPLETED. The shop kept the money, so revenue must say so.
    mockOrderGroupBy.mockResolvedValue([group('COMPLETED', 1, 50_000)]);
    withRefunds(50_000, 50_000);

    await getShopAggregate('shop_1', OWNER);

    expect(stored().create.totalRevenue).toBe(50_000);
  });

  test('revenue never reads negative', async () => {
    // Only reachable if a reversal has been missed. A negative headline figure
    // reads as a broken dashboard rather than as a broken ledger.
    mockOrderGroupBy.mockResolvedValue([group('COMPLETED', 1, 10_000)]);
    withRefunds(50_000);

    await getShopAggregate('shop_1', OWNER);

    expect(stored().create.totalRevenue).toBe(0);
  });
});

describe('pendingPayouts is the value of pending payouts', () => {
  test('holds the sum of PENDING payouts, not the clearing balance', async () => {
    // It held `shop.pendingBalance` — money earned inside the settlement window,
    // which has nothing to do with payouts. Beside `pendingPayoutCount` that
    // produced "₹X across N pending payouts" from two unrelated numbers.
    await getShopAggregate('shop_1', OWNER);

    expect(stored().create.pendingPayouts).toBe(PENDING_PAISE);
    expect(stored().create.pendingPayouts).not.toBe(12_500); // the clearing balance
  });

  test('is asked for over PENDING rows only', async () => {
    await getShopAggregate('shop_1', OWNER);

    expect(mockPayoutAggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopId: 'shop_1', status: 'PENDING' } })
    );
  });
});
