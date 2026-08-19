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
 *   failed   → 'failed',    student told it failed, admin view corrected
 *
 * The vocabulary is not new — `types.ts` documents refundStatus as
 * "processed" | "pending" | "FAILED", and both dashboards already render all
 * three. Only the server never wrote the other two.
 */

import crypto from 'crypto';

// ── prisma ──
const mockRefundFindUnique = jest.fn();
const mockRefundUpdate = jest.fn();
const mockWebhookUpdateMany = jest.fn();
const mockRefundFindFirst = jest.fn();
const mockRefundUpdateMany = jest.fn();
const mockOrderUpdateMany = jest.fn();
const mockLedgerFindUnique = jest.fn();
const mockWebhookUpsert = jest.fn();
const mockWebhookUpdate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    // `refundRequest.update` is the attempt counter claimed before the gateway
    // call — each attempt carries its own idempotency key so a retry is a new
    // refund, not a replay of the failed one.
    //
    // `webhookEvent.updateMany` is the processing claim. `processed` alone is
    // read before the handler runs and written after, so two concurrent
    // deliveries both passed it; claiming is a compare-and-swap that only one
    // can win.
    refundRequest: { findUnique: mockRefundFindUnique, update: mockRefundUpdate },
    webhookEvent: {
      upsert: mockWebhookUpsert,
      update: mockWebhookUpdate,
      updateMany: mockWebhookUpdateMany,
    },
    $transaction: mockTransaction,
  },
}));

// ── collaborators ──
const mockShopShareOfRefund = jest.fn();
const mockCreateLedgerEntry = jest.fn();
// The real `refundLedgerEventId` / `refundReversalEventId` are kept, because
// which key an attempt writes under is exactly what these tests are pinning —
// a stub would let the production keys drift without failing anything here.
jest.mock('../services/ledger.service', () => ({
  ...jest.requireActual('../services/ledger.service'),
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
  mockRefundUpdate.mockResolvedValue({ attempts: 1 });
  mockRefundUpdateMany.mockResolvedValue({ count: 1 });
  mockOrderUpdateMany.mockResolvedValue({ count: 1 });
  mockShopShareOfRefund.mockResolvedValue(0);
  mockCreateLedgerEntry.mockResolvedValue(undefined);
  mockLedgerFindUnique.mockResolvedValue({ id: 'ledger_1', amount: 12500 });
  mockWebhookUpsert.mockResolvedValue({ processed: false });
  mockWebhookUpdate.mockResolvedValue({ attempts: 1, eventType: 'refund.processed' });
  // count 1 = this delivery won the processing claim, the ordinary case.
  mockWebhookUpdateMany.mockResolvedValue({ count: 1 });
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
      // No failed attempts yet: this is attempt 1, which keeps the original
      // `refund:<id>` ledger key. Only retries carry a suffix.
      attempts: 0,
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
      // Not yet failed, so the attempt being failed here is attempt 1.
      attempts: 0,
      razorpayRefundId: 'rfnd_new',
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

    expect(orderDataWith('refundStatus').refundStatus).toBe('failed');
  });

  test('the correction survives a refund that had already been confirmed', async () => {
    // refund.processed can land first and stamp 'processed', with refund.failed
    // following. Clearing the field only when it is still 'pending' would leave
    // exactly the lie this fixes.
    await failAfterAccepting('RESOLVED_REFUNDED');

    expect(orderDataWith('refundStatus').refundStatus).toBe('failed');
    expect(mockNotifyRefundFailed).toHaveBeenCalled();
  });

  test('the request is marked REFUND_FAILED for an admin to retry', async () => {
    await failAfterAccepting('PROCESSING_REFUND');

    expect(requestData().status).toBe('REFUND_FAILED');
  });

  test('the dead refund id is cleared so a retry reaches the gateway', async () => {
    await failAfterAccepting('PROCESSING_REFUND');

    // `settleClaimedRefund` reads a stored refund id as "already in flight" and
    // skips the Razorpay call entirely. Leaving the failed id here made every
    // retry a silent no-op: the request went back to PROCESSING_REFUND and sat
    // there waiting for a webhook that had already been delivered, while the
    // student was never refunded.
    expect(requestData().razorpayRefundId).toBeNull();
  });

  test('the attempt is counted, so the retry is a new one to gateway and ledger', async () => {
    await failAfterAccepting('PROCESSING_REFUND');

    // This is the only place `attempts` advances. Counting failures rather than
    // starts is what keeps a retry after a *lost transaction* on the same key —
    // where the refund is real and re-sending it would pay the student twice —
    // while making a retry after a *failure* look new to both.
    expect(requestData().attempts).toEqual({ increment: 1 });
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
      attempts: 1,
    });
    await deliver('refund.failed', { id: 'rfnd_new', payment_id: 'pay_1', amount: 12500 });

    expect(mockNotifyRefundFailed).not.toHaveBeenCalled();
  });
});

/**
 * The status lists must stay in step across the three roles.
 *
 * `REFUND_FAILED` was added to the shop's claimable list and missed in the
 * admin route's, which was written out inline beside it — so the retry that
 * the enum, the cleanup service and the failure notification all promise
 * answered "invalid state", and a failed refund had no way forward at all.
 *
 * The lists are now shared constants rather than inline copies. These pin the
 * relationships between them, so adding a status to one and forgetting another
 * fails here rather than in production.
 */
describe('who may act on a refund request', () => {
  test('a failed refund is retryable by both a shop and an admin', async () => {
    const { SHOP_CLAIMABLE_STATUSES, ADMIN_APPROVABLE_STATUSES } = await import('../services/refund.service');

    expect(SHOP_CLAIMABLE_STATUSES).toContain('REFUND_FAILED');
    expect(ADMIN_APPROVABLE_STATUSES).toContain('REFUND_FAILED');
  });

  test('a failed refund can also be denied, so the claim can be closed out', async () => {
    // Otherwise it stays open forever — and an open claim pins the order's
    // files, because UNSETTLED_REFUND_STATUSES counts it as a live dispute.
    const { ADMIN_ACTIONABLE_STATUSES } = await import('../services/refund.service');

    expect(ADMIN_ACTIONABLE_STATUSES).toContain('REFUND_FAILED');
  });

  test('approving may re-drive an in-flight refund; denying may not', async () => {
    // A stalled refund can be pushed along. Denying one whose money may already
    // have moved is not a decision this endpoint can honour.
    const { ADMIN_ACTIONABLE_STATUSES, ADMIN_APPROVABLE_STATUSES } = await import('../services/refund.service');

    expect(ADMIN_APPROVABLE_STATUSES).toContain('PROCESSING_REFUND');
    expect(ADMIN_ACTIONABLE_STATUSES).not.toContain('PROCESSING_REFUND');
  });

  test('everything an admin may act on, an approval may also act on', async () => {
    const { ADMIN_ACTIONABLE_STATUSES, ADMIN_APPROVABLE_STATUSES } = await import('../services/refund.service');

    for (const status of ADMIN_ACTIONABLE_STATUSES) {
      expect(ADMIN_APPROVABLE_STATUSES).toContain(status);
    }
  });

  test('a settled refund is reopenable by nobody', async () => {
    const { SHOP_CLAIMABLE_STATUSES, ADMIN_APPROVABLE_STATUSES } = await import('../services/refund.service');

    for (const settled of ['RESOLVED_REFUNDED', 'REFUND_SETTLED_OFFLINE', 'RESOLVED_DENIED'] as const) {
      expect(SHOP_CLAIMABLE_STATUSES).not.toContain(settled);
      expect(ADMIN_APPROVABLE_STATUSES).not.toContain(settled);
    }
  });

  test('cancelling an order takes over a claim the shop rejected', async () => {
    // The sequence this pins: student claims a refund, shop rejects it, shop
    // then cancels the order anyway. The rejection settled a *dispute*; the
    // cancellation is the shop deciding the order will not be fulfilled, and
    // that has to return the money regardless. Leaving REJECTED_BY_SHOP out of
    // this list meant the order was cancelled, the student stayed charged, and
    // no refund was issued or even queued.
    const { CANCELLATION_CLAIMABLE_STATUSES } = await import('../services/refund.service');

    expect(CANCELLATION_CLAIMABLE_STATUSES).toContain('REJECTED_BY_SHOP');
  });

  test('a cancellation never re-claims a refund the gateway failed', async () => {
    // REFUND_FAILED rows belong to the retry paths, which clear the dead
    // gateway id and advance the attempt counter first. Re-claiming one here
    // would present a spent idempotency key and get the dead refund back.
    const { CANCELLATION_CLAIMABLE_STATUSES } = await import('../services/refund.service');

    expect(CANCELLATION_CLAIMABLE_STATUSES).not.toContain('REFUND_FAILED');
  });

  test('a cancellation never reopens a finished refund', async () => {
    const { CANCELLATION_CLAIMABLE_STATUSES } = await import('../services/refund.service');

    for (const settled of ['RESOLVED_REFUNDED', 'REFUND_SETTLED_OFFLINE', 'RESOLVED_DENIED', 'PROCESSING_REFUND'] as const) {
      expect(CANCELLATION_CLAIMABLE_STATUSES).not.toContain(settled);
    }
  });
});
