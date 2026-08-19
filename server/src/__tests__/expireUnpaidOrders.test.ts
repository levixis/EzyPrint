/**
 * Unpaid orders are cancelled after three days, and their files go with them.
 *
 * Both the inline purge and the retention sweep are gated on a terminal status,
 * so an order that never reaches one keeps its document forever. The largest
 * population that never reaches one is exactly this: uploaded, never paid,
 * walked away. Scanned IDs and coursework are what sits in that bucket.
 *
 * The part of this that carries real risk is not the cancelling — it is the
 * gateway check before it. A Razorpay order outlives our idea of the payment:
 * the sheet can be completed days later, and a capture whose webhook was lost
 * is indistinguishable from an abandoned draft when read from our side. Cancel
 * one of those and a student who actually paid loses their document. So the
 * job must fail *closed* whenever it cannot establish that no money moved —
 * which is what most of these tests are about.
 */

const mockOrderFindMany = jest.fn();
const mockOrderFindUnique = jest.fn();
const mockOrderUpdateMany = jest.fn();
const mockWebhookUpdate = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    order: {
      findMany: mockOrderFindMany,
      findUnique: mockOrderFindUnique,
      updateMany: mockOrderUpdateMany,
    },
    webhookEvent: { update: mockWebhookUpdate },
    $transaction: jest.fn(),
  },
}));

const mockOrdersFetch = jest.fn();
const mockOrdersFetchPayments = jest.fn();
jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { fetch: mockOrdersFetch, fetchPayments: mockOrdersFetchPayments, create: jest.fn() },
  }))
);

const mockUpdateOrderStatus = jest.fn();
jest.mock('../services/order.service', () => ({
  updateOrderStatus: mockUpdateOrderStatus,
  repriceFromVerifiedPages: jest.fn(),
  fingerprintPricedFiles: jest.fn().mockResolvedValue('fp'),
  pricedFilesUnchanged: jest.fn().mockResolvedValue(true),
}));

jest.mock('../services/notify.service', () => ({
  notifyNewOrder: jest.fn(),
  notifyAdmins: jest.fn(),
}));
jest.mock('../services/ledger.service', () => ({}));
jest.mock('../services/realtime.service', () => ({ publishQueued: jest.fn() }));

import { expireStaleUnpaidOrders } from '../services/payment.service';

const FOUR_DAYS_AGO = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);

/** An order old enough to expire. `reachedCheckout` gives it a gateway order. */
const staleOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'order_stale',
  status: 'PENDING_PAYMENT',
  razorpayOrderId: null,
  totalPrice: 300,
  uploadedAt: FOUR_DAYS_AGO,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockOrderFindMany.mockResolvedValue([]);
  mockUpdateOrderStatus.mockResolvedValue({});
});

describe('selecting what to expire', () => {
  test('asks only for unpaid orders older than the cutoff', async () => {
    await expireStaleUnpaidOrders();

    const where = mockOrderFindMany.mock.calls[0][0].where;
    expect(where.status.in.sort()).toEqual(['PAYMENT_FAILED', 'PENDING_PAYMENT']);
    expect(where.uploadedAt.lt).toBeInstanceOf(Date);
  });

  test('the cutoff is three days, not seven', async () => {
    const now = new Date('2026-08-19T12:00:00Z');
    await expireStaleUnpaidOrders(now);

    const cutoff = mockOrderFindMany.mock.calls[0][0].where.uploadedAt.lt as Date;
    const days = (now.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(3);
  });

  test('the batch is bounded, so a backlog cannot monopolise one run', async () => {
    await expireStaleUnpaidOrders();
    expect(mockOrderFindMany.mock.calls[0][0].take).toBeGreaterThan(0);
  });
});

describe('an order that never reached checkout', () => {
  test('is cancelled without troubling the gateway', async () => {
    // No razorpayOrderId means no payment can possibly exist, so there is
    // nothing to ask about.
    mockOrderFindMany.mockResolvedValue([staleOrder()]);

    const result = await expireStaleUnpaidOrders();

    expect(mockOrdersFetch).not.toHaveBeenCalled();
    expect(mockUpdateOrderStatus).toHaveBeenCalledWith('order_stale', 'CANCELLED', expect.any(String), 'ADMIN');
    expect(result.cancelled).toBe(1);
  });

  test('cancels through the ordinary transition, not a bare status write', async () => {
    // Going through updateOrderStatus is what notifies the student, purges the
    // files and gives claimCancellationRefund its say. A direct write would
    // skip all three.
    mockOrderFindMany.mockResolvedValue([staleOrder()]);

    await expireStaleUnpaidOrders();

    expect(mockUpdateOrderStatus).toHaveBeenCalledTimes(1);
    expect(mockOrderUpdateMany).not.toHaveBeenCalled();
  });
});

describe('an order that reached checkout — the gateway check', () => {
  const atCheckout = () => staleOrder({ razorpayOrderId: 'order_Rzp1' });

  test('is cancelled when the gateway confirms it was never paid', async () => {
    mockOrderFindMany.mockResolvedValue([atCheckout()]);
    mockOrdersFetch.mockResolvedValue({ status: 'created' });

    const result = await expireStaleUnpaidOrders();

    expect(mockOrdersFetch).toHaveBeenCalledWith('order_Rzp1');
    expect(result.cancelled).toBe(1);
  });

  test('is NOT cancelled when the gateway says it was paid', async () => {
    // The webhook was lost and this looks abandoned from our side. Cancelling
    // would delete the document of an order somebody paid for.
    mockOrderFindMany.mockResolvedValue([atCheckout()]);
    mockOrdersFetch.mockResolvedValue({ status: 'paid' });
    mockOrdersFetchPayments.mockResolvedValue({
      items: [{ id: 'pay_1', status: 'captured', amount: 300 }],
    });
    mockOrderUpdateMany.mockResolvedValue({ count: 1 });

    const result = await expireStaleUnpaidOrders();

    expect(mockUpdateOrderStatus).not.toHaveBeenCalled();
    expect(result.cancelled).toBe(0);
    expect(result.stillPaid).toBe(1);
  });

  test('is NOT cancelled when the gateway cannot be reached', async () => {
    // Fail closed. Not knowing whether money moved is not the same as knowing
    // it did not, and the next run can try again — a deleted file cannot.
    mockOrderFindMany.mockResolvedValue([atCheckout()]);
    mockOrdersFetch.mockRejectedValue(new Error('ECONNRESET'));

    const result = await expireStaleUnpaidOrders();

    expect(mockUpdateOrderStatus).not.toHaveBeenCalled();
    expect(result.cancelled).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('one unreachable order does not stop the rest of the batch', async () => {
    mockOrderFindMany.mockResolvedValue([
      staleOrder({ id: 'order_a', razorpayOrderId: 'order_RzpA' }),
      staleOrder({ id: 'order_b' }),
    ]);
    mockOrdersFetch.mockRejectedValue(new Error('ECONNRESET'));

    const result = await expireStaleUnpaidOrders();

    expect(result.skipped).toBe(1);
    expect(result.cancelled).toBe(1);
    expect(mockUpdateOrderStatus).toHaveBeenCalledWith('order_b', 'CANCELLED', expect.any(String), 'ADMIN');
  });

  test('a cancellation refused mid-flight is counted, not thrown', async () => {
    // Someone paid or cancelled between the query and the write, and the status
    // guard inside updateOrderStatus refused. That is the guard working.
    mockOrderFindMany.mockResolvedValue([staleOrder()]);
    mockUpdateOrderStatus.mockRejectedValue(new Error('order was updated by someone else'));

    const result = await expireStaleUnpaidOrders();

    expect(result.cancelled).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
