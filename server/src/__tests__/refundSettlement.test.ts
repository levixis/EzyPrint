/**
 * Settlement announces itself — to the student, exactly once.
 *
 * A student who cancels a paid order is the actor on that transition, so
 * notifyOrderStatus deliberately says nothing: they are looking at the screen
 * they just tapped. But the refund behind it settles later — through Razorpay,
 * sometimes via an admin — and nothing announced that. The money reappeared
 * days later with no word from us, which is indistinguishable from the refund
 * having quietly failed.
 *
 * Every route to a settled refund (admin resolution, shop self-refund, and the
 * automatic refund behind a cancellation) funnels through settleClaimedRefund,
 * so that is where the announcement belongs and what these tests pin.
 */

const mockRefundFindUnique = jest.fn();
const mockRefundUpdateMany = jest.fn();
const mockOrderUpdateMany = jest.fn();
const mockTransaction = jest.fn();
const mockNotifyRefundSettled = jest.fn();
const mockShopShareOfRefund = jest.fn();
const mockPublishQueued = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    refundRequest: { findUnique: mockRefundFindUnique },
    $transaction: mockTransaction,
  },
}));

jest.mock('../services/ledger.service', () => ({
  shopShareOfRefund: mockShopShareOfRefund,
  createLedgerEntry: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/realtime.service', () => ({
  publishQueued: mockPublishQueued,
}));

jest.mock('../services/notify.service', () => ({
  notifyRefundSettled: mockNotifyRefundSettled,
  notifyAdmins: jest.fn(),
}));

import { settleClaimedRefund } from '../services/refund.service';

/** A claim already carried to PROCESSING_REFUND and already refunded at the
 *  gateway, so the code under test makes no network call of its own. */
const claimedRequest = (overrides: Record<string, unknown> = {}) => ({
  id: 'refund_1',
  orderId: 'order_1',
  shopId: 'shop_1',
  studentId: 'student_1',
  refundAmount: 12500,
  razorpayRefundId: 'rfnd_existing',
  order: {
    id: 'order_1',
    userId: 'student_1',
    totalPrice: 12500,
    razorpayPaymentId: 'pay_1',
  },
  ...overrides,
});

/** Runs the callback against a tx stub, as prisma.$transaction would. */
const runTransaction = () =>
  mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      refundRequest: { updateMany: mockRefundUpdateMany },
      order: { updateMany: mockOrderUpdateMany },
    })
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockRefundFindUnique.mockResolvedValue(claimedRequest());
  mockRefundUpdateMany.mockResolvedValue({ count: 1 });
  mockOrderUpdateMany.mockResolvedValue({ count: 1 });
  mockShopShareOfRefund.mockResolvedValue(0);
  mockPublishQueued.mockResolvedValue(undefined);
  runTransaction();
});

const settle = () =>
  settleClaimedRefund('refund_1', { setOrderRefunded: true, createdBy: 'ADMIN' });

describe('A settled refund reaches the student', () => {
  test('the student is notified once', async () => {
    await settle();

    expect(mockNotifyRefundSettled).toHaveBeenCalledTimes(1);
    expect(mockNotifyRefundSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        studentUserId: 'student_1',
        orderId: 'order_1',
        shopId: 'shop_1',
        amountPaise: 12500,
      })
    );
  });

  test('a gateway refund is announced as one', async () => {
    await settle();

    expect(mockNotifyRefundSettled).toHaveBeenCalledWith(
      expect.objectContaining({ throughGateway: true })
    );
  });

  test('an order never charged through Razorpay is not announced as a bank refund', async () => {
    // Cash or a free order: the request still closes, but telling the student
    // to watch their bank statement would send them looking for money that was
    // never going to arrive there.
    mockRefundFindUnique.mockResolvedValue(
      claimedRequest({
        razorpayRefundId: null,
        order: { id: 'order_1', userId: 'student_1', totalPrice: 12500, razorpayPaymentId: null },
      })
    );

    await settle();

    expect(mockNotifyRefundSettled).toHaveBeenCalledWith(
      expect.objectContaining({ throughGateway: false })
    );
  });

  test('the announcement follows the commit, not the other way round', async () => {
    const order: string[] = [];
    mockRefundUpdateMany.mockImplementation(async () => {
      order.push('commit');
      return { count: 1 };
    });
    mockNotifyRefundSettled.mockImplementation(() => {
      order.push('notify');
    });

    await settle();

    // Announcing work that has not committed is how a student is told their
    // money is on the way by a transaction that then rolls back.
    expect(order).toEqual(['commit', 'notify']);
  });
});

describe('A repeat delivery stays silent', () => {
  test('losing the status guard does not notify again', async () => {
    // Another delivery of the same settlement got here first. The Razorpay call
    // is idempotent so no money moved twice — and the student must not be told
    // twice either.
    mockRefundUpdateMany.mockResolvedValue({ count: 0 });

    await settle();

    expect(mockNotifyRefundSettled).not.toHaveBeenCalled();
  });

  test('the order is not re-stamped REFUNDED either', async () => {
    mockRefundUpdateMany.mockResolvedValue({ count: 0 });

    await settle();

    expect(mockOrderUpdateMany).not.toHaveBeenCalled();
  });
});
