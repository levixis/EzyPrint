/**
 * Retrying a payment that failed — and noticing when it did not actually fail.
 *
 * PAYMENT_FAILED is written by the client the moment the checkout sheet closes.
 * That is a guess about what the student did next, and it is wrong in both
 * directions:
 *
 *   - The student dismissed the sheet and wants to try again. Every write in
 *     the payment path is guarded on PENDING_PAYMENT, so "Retry Payment"
 *     answered `Order is in PAYMENT_FAILED status, not PENDING_PAYMENT`
 *     forever. One declined card made an order permanently unpayable.
 *
 *   - The student dismissed the sheet and *then* approved the UPI collect in
 *     their bank app. Razorpay captured the money; we recorded a failure.
 *     Reconciliation only swept PENDING_PAYMENT, so nothing ever looked for it.
 *     Charging again on retry would have taken the money twice.
 *
 * So the retry asks the gateway before reopening, and both the sweep and the
 * webhook now accept a PAYMENT_FAILED order as claimable.
 */

const mockOrderFindUnique = jest.fn();
const mockOrderUpdateMany = jest.fn();
const mockOrderFindMany = jest.fn();
const mockWebhookFindMany = jest.fn();
const mockWebhookUpdateMany = jest.fn();
const mockWebhookUpdate = jest.fn();
const mockOrderFindFirst = jest.fn();
const mockOrdersFetch = jest.fn();
const mockOrdersFetchPayments = jest.fn();
const mockOrdersCreate = jest.fn();
const mockNotifyNewOrder = jest.fn();
const mockNotifyAdmins = jest.fn();
const mockReprice = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    order: {
      findUnique: mockOrderFindUnique,
      updateMany: mockOrderUpdateMany,
      findMany: mockOrderFindMany,
    },
    // `updateMany` is the processing claim: the sweep takes exclusive ownership
    // of an event before reprocessing it, so it cannot run one that a live
    // webhook delivery is working on at the same moment. `update` records a
    // failed attempt and releases that claim.
    webhookEvent: {
      findMany: mockWebhookFindMany,
      updateMany: mockWebhookUpdateMany,
      update: mockWebhookUpdate,
    },
    // `processWebhookEvent` does its work in a transaction. Running the callback
    // against the same doubles is enough here — this suite is about which
    // events get dispatched, not about what the handlers write.
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        order: { findFirst: mockOrderFindFirst, updateMany: mockOrderUpdateMany },
        webhookEvent: { update: mockWebhookUpdate },
      }),
  },
}));

jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: {
      fetch: mockOrdersFetch,
      fetchPayments: mockOrdersFetchPayments,
      create: mockOrdersCreate,
    },
  }))
);

jest.mock('../services/notify.service', () => ({
  notifyNewOrder: mockNotifyNewOrder,
  notifyAdmins: mockNotifyAdmins,
}));

jest.mock('../services/order.service', () => ({
  repriceFromVerifiedPages: mockReprice,
  // Stamped alongside `razorpayOrderId` — the moment the price is frozen is the
  // moment the file set it was computed from has to be recorded.
  fingerprintPricedFiles: jest.fn().mockResolvedValue('fp_at_checkout'),
  pricedFilesUnchanged: jest.fn().mockResolvedValue(true),
}));

jest.mock('../services/ledger.service', () => ({}));
jest.mock('../services/realtime.service', () => ({ publishQueued: jest.fn() }));

import { createPaymentOrder, reconcilePayments } from '../services/payment.service';

/** `shop` is included because announcePaidOrder re-reads the order with it. */
const failedOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'order_1',
  userId: 'student_1',
  shopId: 'shop_1',
  status: 'PAYMENT_FAILED',
  totalPrice: 12500,
  razorpayOrderId: 'order_rzp_1',
  razorpayPaymentId: null,
  userName: 'Asha',
  shop: { ownerUserId: 'owner_1' },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockReprice.mockResolvedValue({ changed: false, previousTotal: 12500, totalPrice: 12500, unverifiable: [] });
  mockOrderUpdateMany.mockResolvedValue({ count: 1 });
  mockNotifyNewOrder.mockResolvedValue(undefined);
  // The sweep claims each event before reprocessing it; count 1 means this
  // caller won the claim, which is the ordinary single-instance case.
  mockWebhookUpdateMany.mockResolvedValue({ count: 1 });
  mockWebhookUpdate.mockResolvedValue({ attempts: 1, eventType: 'payment.captured' });
  mockOrderFindFirst.mockResolvedValue(null);
  // Fallback for reads the tests do not sequence explicitly — notably the one
  // announcePaidOrder makes after a recovery. `mockResolvedValueOnce` chains in
  // individual tests are consumed before this.
  mockOrderFindUnique.mockResolvedValue(failedOrder());
});

describe('retrying a failed payment', () => {
  test('reopens the order and hands back the same Razorpay order', async () => {
    // Not paid at the gateway — a genuine failure the student wants to retry.
    mockOrdersFetch.mockResolvedValue({ status: 'created' });

    mockOrderFindUnique
      .mockResolvedValueOnce(failedOrder())                             // preflight
      .mockResolvedValueOnce(failedOrder({ status: 'PENDING_PAYMENT' })) // after reopen
      .mockResolvedValueOnce(failedOrder({ status: 'PENDING_PAYMENT' })); // main read

    const result = await createPaymentOrder('order_1', 'student_1');

    // Reopened rather than rejected. This is the assertion that the "Retry
    // Payment" button does anything at all.
    expect(mockOrderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order_1', status: 'PAYMENT_FAILED' },
        data: { status: 'PENDING_PAYMENT' },
      })
    );

    // The same gateway order is reused. Minting a new one would orphan the id
    // a late webhook still refers to.
    expect(result.razorpayOrderId).toBe('order_rzp_1');
    expect(mockOrdersCreate).not.toHaveBeenCalled();
    expect(result.paid).toBeUndefined();
  });

  test('adopts a payment that was actually captured instead of charging again', async () => {
    // The student approved the UPI collect after the sheet closed.
    mockOrdersFetch.mockResolvedValue({ status: 'paid' });
    mockOrdersFetchPayments.mockResolvedValue({
      items: [{ id: 'pay_real', status: 'captured', amount: 12500 }],
    });
    mockOrderFindUnique.mockResolvedValue(failedOrder());

    const result = await createPaymentOrder('order_1', 'student_1');

    expect(result.paid).toBe(true);
    expect(result.recovered).toBe(true);

    // Moved to PENDING_APPROVAL off the status it was actually in.
    expect(mockOrderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order_1', status: 'PAYMENT_FAILED' },
        data: expect.objectContaining({
          status: 'PENDING_APPROVAL',
          razorpayPaymentId: 'pay_real',
        }),
      })
    );

    // Never reopened for payment — that is what would double-charge.
    expect(mockOrderUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PENDING_PAYMENT' } })
    );
    expect(mockNotifyNewOrder).toHaveBeenCalled();
  });

  /**
   * The case that matters most, and the one it is easiest to get backwards.
   *
   * A capture for the wrong amount is not "unpaid". Money left the student's
   * account. Treating it as a failure and reopening the order for payment asks
   * them to pay a second time for an order that already took one payment — so
   * this must be a hard stop, not a retry.
   */
  test('does not reopen an order whose capture had the wrong amount', async () => {
    mockOrdersFetch.mockResolvedValue({ status: 'paid' });
    mockOrdersFetchPayments.mockResolvedValue({
      items: [{ id: 'pay_short', status: 'captured', amount: 100 }],
    });
    mockOrderFindUnique.mockResolvedValue(failedOrder());

    await expect(createPaymentOrder('order_1', 'student_1')).rejects.toThrow(/do not pay again/i);

    // Neither fulfilled nor sent back to checkout.
    expect(mockOrderUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING_APPROVAL' }) })
    );
    expect(mockOrderUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PENDING_PAYMENT' } })
    );

    // A human is told, because we are holding money we will not fulfil against.
    expect(mockNotifyAdmins).toHaveBeenCalledWith(
      expect.stringContaining('order_1'),
      'warning'
    );
  });

  test('does not reopen when the gateway says paid but lists no capture', async () => {
    mockOrdersFetch.mockResolvedValue({ status: 'paid' });
    mockOrdersFetchPayments.mockResolvedValue({ items: [] });
    mockOrderFindUnique.mockResolvedValue(failedOrder());

    await expect(createPaymentOrder('order_1', 'student_1')).rejects.toThrow(/do not pay again/i);
    expect(mockNotifyAdmins).toHaveBeenCalled();
  });

  test('does not reopen when another path already claimed the order', async () => {
    mockOrdersFetch.mockResolvedValue({ status: 'paid' });
    mockOrdersFetchPayments.mockResolvedValue({
      items: [{ id: 'pay_real', status: 'captured', amount: 12500 }],
    });
    mockOrderFindUnique.mockResolvedValue(failedOrder());
    // The webhook committed the transition while we were at the gateway.
    mockOrderUpdateMany.mockResolvedValue({ count: 0 });

    const result = await createPaymentOrder('order_1', 'student_1');

    // Paid, just not by this call — so still never sent back to checkout.
    expect(result.paid).toBe(true);
    expect(result.recovered).toBe(false);
  });

  test('alerts the admins only once about the same stuck payment', async () => {
    mockOrdersFetch.mockResolvedValue({ status: 'paid' });
    mockOrdersFetchPayments.mockResolvedValue({
      items: [{ id: 'pay_short', status: 'captured', amount: 100 }],
    });
    mockOrderFindUnique.mockResolvedValue(failedOrder());
    // Second sweep: the marker is already set, so the guarded write matches
    // nothing. Without this the reconciliation job would mail the admins about
    // the same order every fifteen minutes forever.
    mockOrderUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });

    await expect(createPaymentOrder('order_1', 'student_1')).rejects.toThrow();
    await expect(createPaymentOrder('order_1', 'student_1')).rejects.toThrow();

    expect(mockNotifyAdmins).toHaveBeenCalledTimes(1);
  });

  test('a gateway lookup failure still lets the student retry', async () => {
    // The student is standing there wanting to pay; a Razorpay outage must not
    // be the thing that stops them. A capture that did happen is still found by
    // the sweep, because the same Razorpay order is kept.
    mockOrdersFetch.mockRejectedValue(new Error('razorpay unreachable'));

    mockOrderFindUnique
      .mockResolvedValueOnce(failedOrder())
      .mockResolvedValueOnce(failedOrder({ status: 'PENDING_PAYMENT' }))
      .mockResolvedValueOnce(failedOrder({ status: 'PENDING_PAYMENT' }));

    const result = await createPaymentOrder('order_1', 'student_1');

    expect(result.razorpayOrderId).toBe('order_rzp_1');
    expect(result.paid).toBeUndefined();
  });

  test('a failed order that never reached the gateway is reopened and repriced', async () => {
    mockOrderFindUnique
      .mockResolvedValueOnce(failedOrder({ razorpayOrderId: null }))
      .mockResolvedValueOnce(failedOrder({ razorpayOrderId: null, status: 'PENDING_PAYMENT' }))
      .mockResolvedValueOnce(failedOrder({ razorpayOrderId: null, status: 'PENDING_PAYMENT' }));
    mockOrdersCreate.mockResolvedValue({ id: 'order_rzp_new' });

    await createPaymentOrder('order_1', 'student_1');

    // Nothing to ask the gateway about, so no lookup — but the price is still
    // verified before a new charge is set up.
    expect(mockOrdersFetch).not.toHaveBeenCalled();
    expect(mockReprice).toHaveBeenCalledWith('order_1');
  });
});

describe('reconciliation', () => {
  test('sweeps orders the client marked failed, not just pending ones', async () => {
    mockOrderFindMany.mockResolvedValue([]);
    mockWebhookFindMany.mockResolvedValue([]);

    await reconcilePayments(15);

    expect(mockOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] },
        }),
      })
    );
  });

  test('recovers a captured payment sitting on a failed order', async () => {
    mockOrderFindMany.mockResolvedValue([
      { id: 'order_1', status: 'PAYMENT_FAILED', razorpayOrderId: 'order_rzp_1', totalPrice: 12500 },
    ]);
    mockWebhookFindMany.mockResolvedValue([]);
    mockOrdersFetch.mockResolvedValue({ status: 'paid' });
    mockOrdersFetchPayments.mockResolvedValue({
      items: [{ id: 'pay_real', status: 'captured', amount: 12500 }],
    });

    const result = await reconcilePayments(15);

    expect(result.reconciled).toBe(1);
    expect(mockOrderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order_1', status: 'PAYMENT_FAILED' },
        data: expect.objectContaining({ status: 'PENDING_APPROVAL' }),
      })
    );
    expect(mockNotifyNewOrder).toHaveBeenCalled();
  });

  test('announces nothing when another path already claimed the order', async () => {
    mockOrderFindMany.mockResolvedValue([
      { id: 'order_1', status: 'PENDING_PAYMENT', razorpayOrderId: 'order_rzp_1', totalPrice: 12500 },
    ]);
    mockWebhookFindMany.mockResolvedValue([]);
    mockOrdersFetch.mockResolvedValue({ status: 'paid' });
    mockOrdersFetchPayments.mockResolvedValue({
      items: [{ id: 'pay_real', status: 'captured', amount: 12500 }],
    });
    // The webhook committed the transition while we were at the gateway.
    mockOrderUpdateMany.mockResolvedValue({ count: 0 });

    const result = await reconcilePayments(15);

    expect(result.reconciled).toBe(0);
    expect(mockNotifyNewOrder).not.toHaveBeenCalled();
  });

  test('counts a mismatched capture as flagged rather than reconciled', async () => {
    mockOrderFindMany.mockResolvedValue([
      { id: 'order_1', status: 'PAYMENT_FAILED', razorpayOrderId: 'order_rzp_1', totalPrice: 12500 },
    ]);
    mockWebhookFindMany.mockResolvedValue([]);
    mockOrdersFetch.mockResolvedValue({ status: 'paid' });
    mockOrdersFetchPayments.mockResolvedValue({
      items: [{ id: 'pay_short', status: 'captured', amount: 100 }],
    });

    const result = await reconcilePayments(15);

    expect(result.reconciled).toBe(0);
    expect(result.flagged).toBe(1);
    expect(mockNotifyAdmins).toHaveBeenCalled();
  });

  /**
   * The webhook half of this job recovers events nothing else will. It used to
   * sit behind an early return that fired whenever no orders were stuck, so a
   * webhook that died mid-processing was only retried on a sweep that happened
   * to also find a stuck order.
   */
  test('retries unprocessed webhooks even when no orders are stuck', async () => {
    mockOrderFindMany.mockResolvedValue([]);
    mockWebhookFindMany.mockResolvedValue([
      { eventId: 'evt_1', eventType: 'payment.captured', payload: { payload: { payment: { entity: {} } } } },
    ]);

    const result = await reconcilePayments(15);

    expect(result.retriedWebhooks).toBe(1);
  });

  /**
   * An event another caller is already processing is left alone.
   *
   * The claim is what stops the sweep and a live webhook delivery running the
   * same handler at the same moment. `retriedWebhooks` counts what this pass
   * actually reprocessed rather than what it selected, so a lost claim reports
   * honestly instead of taking credit for someone else's work.
   */
  test('skips an event whose claim is held by another caller', async () => {
    mockOrderFindMany.mockResolvedValue([]);
    mockWebhookFindMany.mockResolvedValue([
      { eventId: 'evt_1', eventType: 'payment.captured', payload: { payload: { payment: { entity: {} } } } },
    ]);
    mockWebhookUpdateMany.mockResolvedValue({ count: 0 });

    const result = await reconcilePayments(15);

    expect(result.retriedWebhooks).toBe(0);
  });
});
