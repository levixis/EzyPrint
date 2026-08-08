/**
 * A refund is not finished when Razorpay accepts it.
 *
 * Razorpay refunds are asynchronous. `POST /payments/:id/refund` returning 2xx
 * means the refund was *accepted*, and the response carries a `status` that is
 * usually `pending` — the money has not moved. It moves later, and Razorpay
 * says so with `refund.processed`, or says the opposite with `refund.failed`.
 *
 * The original code collapsed those two moments into one. It read only `data.id`
 * from the response, discarded `data.status`, immediately wrote
 * `Order.refundStatus = 'processed'`, and told the student
 * "₹X has been refunded to your original payment method." That claim rested on
 * acceptance alone.
 *
 * The failure path made it worse. `refund.failed` reversed the shop's ledger
 * deduction and returned the order to COMPLETED, but told the student nothing
 * and left `Order.refundStatus` reading `'processed'` — the field the admin
 * payment badge is derived from. So a refund that Razorpay rejected showed as
 * "Refunded" to the admin, showed as "Refund Processed" to the student, and
 * only the ledger knew otherwise.
 *
 * These tests pin the honest sequence:
 *
 *   accept   → 'pending',   student told it is in progress
 *   processed→ 'processed', student told it landed
 *   failed   → 'FAILED',    student told it failed, admin view corrected
 *
 * The vocabulary is not new — `types.ts` documents refundStatus as
 * "processed" | "pending" | "FAILED", and both dashboards already render all
 * three. Only the server never wrote the other two.
 */

import crypto from 'crypto';

// ── prisma ──
const mockRefundFindUnique = jest.fn();
const mockRefundFindFirst = jest.fn();
const mockRefundUpdateMany = jest.fn();
const mockOrderUpdateMany = jest.fn();
const mockLedgerFindUnique = jest.fn();
const mockWebhookUpsert = jest.fn();
const mockWebhookUpdate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    refundRequest: { findUnique: mockRefundFindUnique },
    webhookEvent: { upsert: mockWebhookUpsert, update: mockWebhookUpdate },
    $transaction: mockTransaction,
  },
}));

// ── collaborators ──
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
const mockNotifyRefundInitiated = jest.fn();
const mockNotifyRefundFailed = jest.fn();
jest.mock('../services/notify.service', () => ({
  notifyRefundSettled: mockNotifyRefundSettled,
  notifyRefundInitiated: mockNotifyRefundInitiated,
  notifyRefundFailed: mockNotifyRefundFailed,
  notifyAdmins: jest.fn(),
  notifyNewOrder: jest.fn(),
  notifyOrderStatus: jest.fn(),
}));

import { settleClaimedRefund } from '../services/refund.service';
import { handleWebhook } from '../services/payment.service';

const WEBHOOK_SECRET = 'test-webhook-secret';

/** A claim already carried to PROCESSING_REFUND, not yet sent to the gateway. */
const claimedRequest = (overrides: Record<string, unknown> = {}) => ({
  id: 'refund_1',
  orderId: 'order_1',
  shopId: 'shop_1',
  studentId: 'student_1',
  status: 'PROCESSING_REFUND',
  refundAmount: 12500,
  razorpayRefundId: null,
  order: {
    id: 'order_1',
    userId: 'student_1',
    totalPrice: 12500,
    razorpayPaymentId: 'pay_1',
  },
  ...overrides,
});

const mockOrderFindUnique = jest.fn();

const txStub = () => ({
  refundRequest: { updateMany: mockRefundUpdateMany, findFirst: mockRefundFindFirst },
  order: { updateMany: mockOrderUpdateMany, findUnique: mockOrderFindUnique },
  ledgerEntry: { findUnique: mockLedgerFindUnique },
  webhookEvent: { update: mockWebhookUpdate },
});

/** Razorpay's refund response. `status` is the field that was being discarded. */
const razorpayAccepts = (status: 'pending' | 'processed') => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'rfnd_new', status, amount: 12500 }),
  }) as unknown as typeof fetch;
};

/** Deliver a webhook through the real signature-checking entry point. */
const deliver = async (eventType: string, refundEntity: Record<string, unknown>) => {
  const body = JSON.stringify({
    event: eventType,
    payload: { refund: { entity: refundEntity } },
  });
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  return handleWebhook(body, signature, WEBHOOK_SECRET, `evt_${eventType}_1`);
};

beforeEach(() => {
  jest.clearAllMocks();

  mockRefundFindUnique.mockResolvedValue(claimedRequest());
  mockRefundUpdateMany.mockResolvedValue({ count: 1 });
  mockOrderUpdateMany.mockResolvedValue({ count: 1 });
  mockShopShareOfRefund.mockResolvedValue(0);
  mockCreateLedgerEntry.mockResolvedValue(undefined);
  mockLedgerFindUnique.mockResolvedValue({ id: 'ledger_1', amount: 12500 });
  mockWebhookUpsert.mockResolvedValue({ processed: false });
  mockWebhookUpdate.mockResolvedValue({});
  mockOrderFindUnique.mockResolvedValue({ userId: 'student_1' });

  mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback(txStub())
  );

  razorpayAccepts('pending');
});

/**
 * The order write that touched `key`.
 *
 * Recording the refund and promoting the order's status are deliberately two
 * statements — the first must run whatever state the order is in, the second
 * must not overwrite CANCELLED — so indexing the calls positionally would pin
 * an implementation detail rather than the behaviour.
 */
const orderDataWith = (key: string): Record<string, unknown> =>
  mockOrderUpdateMany.mock.calls
    .map((call) => call[0]?.data ?? {})
    .find((data) => data[key] !== undefined) ?? {};

/** The `where` of the order write that carries a status guard. */
const guardedOrderWhere = (): Record<string, unknown> =>
  mockOrderUpdateMany.mock.calls
    .map((call) => call[0]?.where ?? {})
    .find((where) => where.status?.notIn) ?? {};

/** The data written to the refund request in the Nth call. */
const requestData = (call = 0) => mockRefundUpdateMany.mock.calls[call]?.[0]?.data ?? {};

const settle = () =>
  settleClaimedRefund('refund_1', { setOrderRefunded: true, createdBy: 'ADMIN' });

// ─────────────────────────────────────────────────────────────
describe('Acceptance is not completion', () => {
  test('a pending refund is not stamped "processed" on the order', async () => {
    await settle();

    // This is the field the admin payment badge reads. Writing 'processed'
    // here is the system asserting the money landed, on no evidence.
    expect(orderDataWith('refundStatus').refundStatus).not.toBe('processed');
    expect(orderDataWith('refundStatus').refundStatus).toBe('pending');
  });

  test('the student is told the refund is in progress, not that it is done', async () => {
    await settle();

    expect(mockNotifyRefundSettled).not.toHaveBeenCalled();
    expect(mockNotifyRefundInitiated).toHaveBeenCalledWith(
      expect.objectContaining({
        studentUserId: 'student_1',
        orderId: 'order_1',
        amountPaise: 12500,
      })
    );
  });

  test('the request stays PROCESSING_REFUND until the gateway confirms', async () => {
    await settle();

    // RESOLVED_REFUNDED is what makes `refund.processed` skip its own
    // completion block, so marking it here is what stranded the confirmation.
    expect(requestData().status).toBe('PROCESSING_REFUND');
  });

  test('the refund id from the accepted call is still recorded', async () => {
    // Needed to match the webhook back to this request, and to make a manual
    // retry idempotent. Recording it is not the same as claiming completion.
    await settle();

    expect(requestData().razorpayRefundId).toBe('rfnd_new');
  });

  test('a refund Razorpay reports as already processed is treated as complete', async () => {
    // Instant refunds do exist. When Razorpay itself says `processed` in the
    // response, that is confirmation, and waiting for a webhook to repeat it
    // would leave the student in limbo for no reason.
    razorpayAccepts('processed');

    await settle();

    expect(orderDataWith('refundStatus').refundStatus).toBe('processed');
    expect(mockNotifyRefundSettled).toHaveBeenCalled();
    expect(requestData().status).toBe('RESOLVED_REFUNDED');
  });

  test('an order never charged through Razorpay settles offline immediately', async () => {
    // Cash or a free order: there is no gateway leg to wait on, so there is no
    // pending state to be honest about.
    mockRefundFindUnique.mockResolvedValue(
      claimedRequest({
        order: { id: 'order_1', userId: 'student_1', totalPrice: 12500, razorpayPaymentId: null },
      })
    );

    await settle();

    expect(requestData().status).toBe('REFUND_SETTLED_OFFLINE');
    expect(mockNotifyRefundSettled).toHaveBeenCalledWith(
      expect.objectContaining({ throughGateway: false })
    );
  });
});

// ─────────────────────────────────────────────────────────────
describe('refund.processed confirms it', () => {
  beforeEach(() => {
    mockRefundFindFirst.mockResolvedValue({
      id: 'refund_1',
      orderId: 'order_1',
      shopId: 'shop_1',
      status: 'PROCESSING_REFUND',
    });
  });

  test('the order is finally stamped processed', async () => {
    await deliver('refund.processed', { id: 'rfnd_new', payment_id: 'pay_1', amount: 12500 });

    expect(orderDataWith('refundStatus').refundStatus).toBe('processed');
  });

  test('the student is told the money has landed', async () => {
    await deliver('refund.processed', { id: 'rfnd_new', payment_id: 'pay_1', amount: 12500 });

    expect(mockNotifyRefundSettled).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order_1', amountPaise: 12500, throughGateway: true })
    );
  });

  test('the request moves to RESOLVED_REFUNDED', async () => {
    await deliver('refund.processed', { id: 'rfnd_new', payment_id: 'pay_1', amount: 12500 });

    expect(requestData().status).toBe('RESOLVED_REFUNDED');
  });

  test('a cancelled order keeps CANCELLED rather than being re-terminalised', async () => {
    // There is no CANCELLED -> REFUNDED edge in VALID_TRANSITIONS, and
    // CANCELLED is the more meaningful record of why the order ended. Now that
    // the request is left in PROCESSING_REFUND at acceptance, this webhook
    // reaches the completion block for cancellation refunds too — which it
    // previously never did.
    await deliver('refund.processed', { id: 'rfnd_new', payment_id: 'pay_1', amount: 12500 });

    expect(guardedOrderWhere().status).toEqual(
      expect.objectContaining({ notIn: expect.arrayContaining(['CANCELLED']) })
    );
  });
});

// ─────────────────────────────────────────────────────────────
// The sequence this whole change exists for.
// ─────────────────────────────────────────────────────────────
describe('accept, then fail', () => {
  const failAfterAccepting = async (statusAtFailure: string) => {
    // 1. We accept and record a pending refund.
    await settle();
    jest.clearAllMocks();
    mockOrderUpdateMany.mockResolvedValue({ count: 1 });
    mockRefundUpdateMany.mockResolvedValue({ count: 1 });
    mockLedgerFindUnique.mockResolvedValue({ id: 'ledger_1', amount: 12500 });
    mockWebhookUpsert.mockResolvedValue({ processed: false });
    mockCreateLedgerEntry.mockResolvedValue(undefined);
    mockOrderFindUnique.mockResolvedValue({ userId: 'student_1' });
    mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(txStub())
    );
    mockRefundFindFirst.mockResolvedValue({
      id: 'refund_1',
      orderId: 'order_1',
      shopId: 'shop_1',
      status: statusAtFailure,
    });

    // 2. Razorpay fails it asynchronously.
    await deliver('refund.failed', { id: 'rfnd_new', payment_id: 'pay_1', amount: 12500 });
  };

  test('the student is told their refund failed', async () => {
    await failAfterAccepting('PROCESSING_REFUND');

    // They were last told the refund was on its way. Leaving that as the final
    // word means they wait 5-7 days for money that is never coming, and the
    // first anyone hears about it is a support ticket.
    expect(mockNotifyRefundFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        studentUserId: 'student_1',
        orderId: 'order_1',
        amountPaise: 12500,
      })
    );
  });

  test('the order stops claiming the refund was processed', async () => {
    await failAfterAccepting('PROCESSING_REFUND');

    expect(orderDataWith('refundStatus').refundStatus).toBe('FAILED');
  });

  test('the correction survives a refund that had already been confirmed', async () => {
    // refund.processed can land first and stamp 'processed', with refund.failed
    // following. Clearing the field only when it is still 'pending' would leave
    // exactly the lie this fixes.
    await failAfterAccepting('RESOLVED_REFUNDED');

    expect(orderDataWith('refundStatus').refundStatus).toBe('FAILED');
    expect(mockNotifyRefundFailed).toHaveBeenCalled();
  });

  test('the request is marked REFUND_FAILED for an admin to retry', async () => {
    await failAfterAccepting('PROCESSING_REFUND');

    expect(requestData().status).toBe('REFUND_FAILED');
  });

  test("the shop's ledger deduction is still reversed", async () => {
    // The pre-existing behaviour, pinned so the notification work above cannot
    // quietly displace it — the student's money never moved, so the shop must
    // not stay charged.
    await failAfterAccepting('PROCESSING_REFUND');

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

  test('the student is not told twice by a redelivered failure', async () => {
    await failAfterAccepting('PROCESSING_REFUND');
    mockNotifyRefundFailed.mockClear();

    // A redelivery finds the request already REFUND_FAILED, which is outside
    // the guarded set, so nothing runs and nobody is told again.
    mockRefundFindFirst.mockResolvedValue({
      id: 'refund_1',
      orderId: 'order_1',
      shopId: 'shop_1',
      status: 'REFUND_FAILED',
    });
    await deliver('refund.failed', { id: 'rfnd_new', payment_id: 'pay_1', amount: 12500 });

    expect(mockNotifyRefundFailed).not.toHaveBeenCalled();
  });
});
