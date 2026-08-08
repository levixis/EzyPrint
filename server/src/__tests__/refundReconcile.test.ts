/**
 * The pull side of the refund lifecycle.
 *
 * A refund is not finished when Razorpay accepts it, so `settleClaimedRefund`
 * leaves the request in PROCESSING_REFUND and waits to be told how it ended.
 * The thing that tells us is the `refund.processed` / `refund.failed` webhook —
 * and that is a checkbox in the Razorpay dashboard, ticked by hand, separate
 * per mode. `webhook_events` has never held a single row for either one despite
 * completed refunds.
 *
 * So the honest lifecycle introduced a dependency on configuration that has
 * never worked. Left alone, an unticked box means every refund sits in
 * PROCESSING_REFUND forever: the student is told their money is on its way and
 * never told it arrived, the shop is never debited, `Order.refundStatus` stays
 * `pending` on both dashboards, and the files are pinned by
 * `UNSETTLED_REFUND_STATUSES` and never purged. Nothing errors.
 *
 * `reconcileStuckRefunds` closes that by going and asking. These tests pin the
 * three things that make it safe to run unattended:
 *
 *   - it applies the gateway's answer, never its own
 *   - it can finish a refund but never start one
 *   - it converges with the webhook rather than racing it to a double effect
 */

const mockRefundFindMany = jest.fn();
const mockRefundFindUnique = jest.fn();
const mockRefundUpdateMany = jest.fn();
const mockOrderUpdateMany = jest.fn();
const mockOrderFindUnique = jest.fn();
const mockLedgerFindUnique = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    refundRequest: { findMany: mockRefundFindMany },
    $transaction: mockTransaction,
  },
}));

const mockRefundsFetch = jest.fn();
const mockFetchMultipleRefund = jest.fn();

jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    refunds: { fetch: mockRefundsFetch },
    payments: { fetchMultipleRefund: mockFetchMultipleRefund, all: jest.fn() },
    orders: { fetch: jest.fn(), fetchPayments: jest.fn(), create: jest.fn(), all: jest.fn() },
  }))
);

const mockShopShareOfRefund = jest.fn();
const mockCreateLedgerEntry = jest.fn();
jest.mock('../services/ledger.service', () => ({
  shopShareOfRefund: mockShopShareOfRefund,
  createLedgerEntry: mockCreateLedgerEntry,
}));

jest.mock('../services/realtime.service', () => ({
  publishQueued: jest.fn().mockResolvedValue(undefined),
  enqueueShopEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/order.service', () => ({}));

const mockNotifyRefundSettled = jest.fn();
const mockNotifyRefundFailed = jest.fn();
jest.mock('../services/notify.service', () => ({
  notifyRefundSettled: mockNotifyRefundSettled,
  notifyRefundFailed: mockNotifyRefundFailed,
  notifyRefundInitiated: jest.fn(),
  notifyAdmins: jest.fn(),
  notifyNewOrder: jest.fn(),
  notifyOrderStatus: jest.fn(),
}));

import { reconcileStuckRefunds } from '../services/payment.service';

/** A request that says it is refunding, with the gateway's id recorded. */
const stuckRequest = (overrides: Record<string, unknown> = {}) => ({
  id: 'refund_1',
  orderId: 'order_1',
  shopId: 'shop_1',
  status: 'PROCESSING_REFUND',
  razorpayRefundId: 'rfnd_1',
  order: { razorpayPaymentId: 'pay_1' },
  ...overrides,
});

const txStub = () => ({
  refundRequest: { findUnique: mockRefundFindUnique, updateMany: mockRefundUpdateMany },
  order: { updateMany: mockOrderUpdateMany, findUnique: mockOrderFindUnique },
  ledgerEntry: { findUnique: mockLedgerFindUnique },
});

/** The order write that touched `key`, whichever statement carried it. */
const orderDataWith = (key: string): Record<string, unknown> =>
  mockOrderUpdateMany.mock.calls
    .map((call) => call[0]?.data ?? {})
    .find((data) => data[key] !== undefined) ?? {};

const requestData = () => mockRefundUpdateMany.mock.calls[0]?.[0]?.data ?? {};

beforeEach(() => {
  jest.clearAllMocks();

  mockRefundFindMany.mockResolvedValue([stuckRequest()]);
  mockRefundFindUnique.mockResolvedValue(stuckRequest());
  mockRefundUpdateMany.mockResolvedValue({ count: 1 });
  mockOrderUpdateMany.mockResolvedValue({ count: 1 });
  mockOrderFindUnique.mockResolvedValue({ userId: 'student_1' });
  mockLedgerFindUnique.mockResolvedValue({ id: 'ledger_1', amount: 12500 });
  mockShopShareOfRefund.mockResolvedValue(12500);
  mockCreateLedgerEntry.mockResolvedValue(undefined);

  mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback(txStub())
  );
});

// ─────────────────────────────────────────────────────────────
describe('a refund the gateway has settled', () => {
  beforeEach(() => {
    mockRefundsFetch.mockResolvedValue({ id: 'rfnd_1', amount: 12500, status: 'processed' });
  });

  test('is confirmed without any webhook arriving', async () => {
    const result = await reconcileStuckRefunds();

    expect(result.confirmed).toBe(1);
    expect(requestData().status).toBe('RESOLVED_REFUNDED');
  });

  test('stamps the order processed, so both dashboards stop saying pending', async () => {
    await reconcileStuckRefunds();

    expect(orderDataWith('refundStatus').refundStatus).toBe('processed');
  });

  test('debits the shop for its share', async () => {
    // The deduction is not a side effect of the webhook — it is a side effect
    // of the refund settling, and this is the path that notices it settled.
    await reconcileStuckRefunds();

    expect(mockCreateLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'REFUND_DEDUCTION',
        amount: 12500,
        eventId: 'refund:refund_1',
      }),
      expect.anything(),
      expect.anything()
    );
  });

  test('tells the student their money landed', async () => {
    await reconcileStuckRefunds();

    expect(mockNotifyRefundSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        studentUserId: 'student_1',
        orderId: 'order_1',
        amountPaise: 12500,
        throughGateway: true,
      })
    );
  });
});

// ─────────────────────────────────────────────────────────────
describe('a refund the gateway has failed', () => {
  beforeEach(() => {
    mockRefundsFetch.mockResolvedValue({ id: 'rfnd_1', amount: 12500, status: 'failed' });
  });

  test('is the only way a failure is noticed when the webhook is not configured', async () => {
    const result = await reconcileStuckRefunds();

    expect(result.failed).toBe(1);
    expect(requestData().status).toBe('REFUND_FAILED');
  });

  test("reverses the shop's deduction", async () => {
    // The student's money never moved, so the shop must not stay charged.
    await reconcileStuckRefunds();

    expect(mockCreateLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ADJUSTMENT',
        amount: 12500,
        eventId: 'refund:refund_1:reversal',
      }),
      expect.anything(),
      expect.anything()
    );
  });

  test('corrects the order rather than leaving it claiming a refund', async () => {
    await reconcileStuckRefunds();

    expect(orderDataWith('refundStatus').refundStatus).toBe('FAILED');
  });

  test('tells the student, who was last told it was on its way', async () => {
    await reconcileStuckRefunds();

    expect(mockNotifyRefundFailed).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order_1', amountPaise: 12500 })
    );
  });
});

// ─────────────────────────────────────────────────────────────
describe('a refund the gateway is still working on', () => {
  test('is left exactly as it is', async () => {
    // Razorpay usually settles in minutes and is entitled to take days. The
    // staleness threshold decides when to ask, not what the answer is.
    mockRefundsFetch.mockResolvedValue({ id: 'rfnd_1', amount: 12500, status: 'pending' });

    const result = await reconcileStuckRefunds();

    expect(result.stillPending).toBe(1);
    expect(result.confirmed).toBe(0);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockNotifyRefundSettled).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
describe('a request with no refund id', () => {
  // The crash this whole function exists to survive: callRazorpayRefund
  // returned, the local transaction failed to commit, and the id was lost while
  // the refund is real and in flight at the gateway.
  beforeEach(() => {
    mockRefundFindMany.mockResolvedValue([stuckRequest({ razorpayRefundId: null })]);
    mockRefundFindUnique.mockResolvedValue(stuckRequest({ razorpayRefundId: null }));
  });

  test('is matched by listing the payment refunds', async () => {
    mockFetchMultipleRefund.mockResolvedValue({
      items: [{ id: 'rfnd_lost', amount: 12500, status: 'processed', notes: { orderId: 'order_1' } }],
    });

    const result = await reconcileStuckRefunds();

    expect(mockFetchMultipleRefund).toHaveBeenCalledWith('pay_1');
    expect(result.confirmed).toBe(1);
    expect(requestData().razorpayRefundId).toBe('rfnd_lost');
  });

  test('matches on notes.orderId rather than taking the first refund', async () => {
    // A payment can carry more than one refund. Picking positionally would
    // attribute someone else's partial refund to this request and settle it for
    // the wrong amount.
    mockFetchMultipleRefund.mockResolvedValue({
      items: [
        { id: 'rfnd_other', amount: 500, status: 'processed', notes: { orderId: 'order_99' } },
        { id: 'rfnd_ours', amount: 12500, status: 'processed', notes: { orderId: 'order_1' } },
      ],
    });

    await reconcileStuckRefunds();

    expect(requestData().razorpayRefundId).toBe('rfnd_ours');
    expect(requestData().refundAmount).toBe(12500);
  });

  test('is reported as stranded when the gateway has no refund at all', async () => {
    // The refund was never actually initiated. Waiting cannot fix that — the
    // money is still with us and a human has to retry it.
    mockFetchMultipleRefund.mockResolvedValue({ items: [] });

    const result = await reconcileStuckRefunds();

    expect(result.stranded).toEqual(['refund_1']);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
describe('converging with the webhook rather than racing it', () => {
  test('a request the webhook already settled is not settled twice', async () => {
    mockRefundsFetch.mockResolvedValue({ id: 'rfnd_1', amount: 12500, status: 'processed' });

    // The gateway call is a network round trip, and the webhook can land during
    // it. The re-read inside the transaction sees the settled row and the
    // status guard makes this caller silent.
    mockRefundFindUnique.mockResolvedValue(stuckRequest({ status: 'RESOLVED_REFUNDED' }));

    const result = await reconcileStuckRefunds();

    expect(mockRefundUpdateMany).not.toHaveBeenCalled();
    expect(mockCreateLedgerEntry).not.toHaveBeenCalled();
    expect(mockNotifyRefundSettled).not.toHaveBeenCalled();
    // Counted on what this pass moved, so the remediation log does not claim
    // credit for work the webhook did.
    expect(result).toMatchObject({ checked: 1, confirmed: 0, failed: 0 });
  });

  test('a row that vanished between the scan and the transaction is skipped', async () => {
    mockRefundsFetch.mockResolvedValue({ id: 'rfnd_1', amount: 12500, status: 'processed' });
    mockRefundFindUnique.mockResolvedValue(null);

    await expect(reconcileStuckRefunds()).resolves.toMatchObject({ errors: 0 });
    expect(mockNotifyRefundSettled).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
describe('the scan itself', () => {
  test('only asks about requests that are actually refunding', async () => {
    mockRefundsFetch.mockResolvedValue({ id: 'rfnd_1', amount: 12500, status: 'pending' });

    await reconcileStuckRefunds();

    expect(mockRefundFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PROCESSING_REFUND' }),
      })
    );
  });

  test('falls back to the request date when the settle path never stamped one', async () => {
    // `adminResolvedAt` is written when the gateway leg starts, so it is null
    // for exactly the requests whose settle transaction died — the ones that
    // most need reconciling. Filtering on it alone would skip them forever.
    mockRefundsFetch.mockResolvedValue({ id: 'rfnd_1', amount: 12500, status: 'pending' });

    await reconcileStuckRefunds();

    const where = mockRefundFindMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { adminResolvedAt: { lt: expect.any(Date) } },
      { adminResolvedAt: null, studentRequestedAt: { lt: expect.any(Date) } },
    ]);
  });

  test('is bounded, so a backlog cannot become a stampede', async () => {
    mockRefundsFetch.mockResolvedValue({ id: 'rfnd_1', amount: 12500, status: 'pending' });

    await reconcileStuckRefunds({ limit: 25 });

    expect(mockRefundFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }));
  });

  test('one unreachable refund does not stop the rest of the batch', async () => {
    mockRefundFindMany.mockResolvedValue([
      stuckRequest({ id: 'refund_1', razorpayRefundId: 'rfnd_1' }),
      stuckRequest({ id: 'refund_2', razorpayRefundId: 'rfnd_2' }),
    ]);
    mockRefundsFetch
      .mockRejectedValueOnce(new Error('gateway timeout'))
      .mockResolvedValueOnce({ id: 'rfnd_2', amount: 12500, status: 'processed' });

    const result = await reconcileStuckRefunds();

    expect(result.errors).toBe(1);
    expect(result.confirmed).toBe(1);
  });
});
