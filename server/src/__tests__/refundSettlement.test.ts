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
const mockCreateLedgerEntry = jest.fn();
const mockPublishQueued = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    refundRequest: { findUnique: mockRefundFindUnique },
    $transaction: mockTransaction,
  },
}));

// The real `refundAttemptNumber` / `refundLedgerEventId` are kept: which key an
// attempt writes under is what separates a retry from a replay, so stubbing
// them would let the production keys drift without failing anything here.
jest.mock('../services/ledger.service', () => ({
  ...jest.requireActual('../services/ledger.service'),
  shopShareOfRefund: mockShopShareOfRefund,
  createLedgerEntry: mockCreateLedgerEntry,
}));

jest.mock('../services/realtime.service', () => ({
  publishQueued: mockPublishQueued,
}));

jest.mock('../services/notify.service', () => ({
  notifyRefundSettled: mockNotifyRefundSettled,
  notifyAdmins: jest.fn(),
}));

import { settleClaimedRefund } from '../services/refund.service';
import { resolveRefundSchema } from '../validators/schemas';

/**
 * A claim carried to PROCESSING_REFUND, whose gateway call comes back
 * **confirmed** — Razorpay reporting `processed` in the refund response, which
 * is what an instant refund looks like.
 *
 * This file is about who gets told once a refund has actually settled, so its
 * fixture has to be a settled one. The unconfirmed case — Razorpay accepting a
 * refund it has not yet moved, which is the common one — is a different
 * sequence with a different message, and lives in `refundLifecycle.test.ts`
 * along with the accept-then-fail path.
 */
const claimedRequest = (overrides: Record<string, unknown> = {}) => ({
  id: 'refund_1',
  orderId: 'order_1',
  shopId: 'shop_1',
  studentId: 'student_1',
  refundAmount: 12500,
  razorpayRefundId: null,
  // No failed attempts yet, so this is attempt 1 — the one that keeps the bare
  // request id as its gateway key and `refund:<id>` as its ledger key.
  attempts: 0,
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

  // Razorpay confirms the refund in the response itself. `status` is what
  // separates a refund that has landed from one merely accepted, and reading
  // it is the difference this fixture depends on.
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'rfnd_existing', status: 'processed', amount: 12500 }),
  }) as unknown as typeof fetch;

  mockRefundFindUnique.mockResolvedValue(claimedRequest());
  mockRefundUpdateMany.mockResolvedValue({ count: 1 });
  mockOrderUpdateMany.mockResolvedValue({ count: 1 });
  mockShopShareOfRefund.mockResolvedValue(0);
  mockCreateLedgerEntry.mockResolvedValue(undefined);
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

/**
 * The refund has to be legible on the order, not only on the request row.
 *
 * `Order.refundId` / `refundStatus` / `refundAmount` survived the migration
 * from Firebase, where the legacy functions populated them. Nothing on this
 * side ever did — they were selected and never written. The admin dashboard
 * derives its payment badge from them, and its "cancelled, paid, nothing
 * refunded" branch was therefore true for every cancelled order forever: two
 * orders refunded to the paisa, each with a Razorpay refund id against it, sat
 * on the admin's screen marked "Needs Refund" indefinitely.
 */
describe('The order records the refund', () => {
  test('a cancellation refund is stamped on the order without changing its status', async () => {
    await settleClaimedRefund('refund_1', { setOrderRefunded: false, createdBy: 'SYSTEM' });

    const data = mockOrderUpdateMany.mock.calls[0][0].data;
    expect(data.refundId).toBe('rfnd_existing');
    expect(data.refundStatus).toBe('processed');
    expect(data.refundAmount).toBe(12500);
    // CANCELLED is the more meaningful terminal state, and there is no
    // CANCELLED -> REFUNDED edge in VALID_TRANSITIONS.
    expect(data.status).toBeUndefined();
  });

  test('an admin resolution stamps the refund and marks the order REFUNDED', async () => {
    await settleClaimedRefund('refund_1', { setOrderRefunded: true, createdBy: 'ADMIN' });

    const data = mockOrderUpdateMany.mock.calls[0][0].data;
    expect(data.status).toBe('REFUNDED');
    expect(data.refundId).toBe('rfnd_existing');
    expect(data.refundStatus).toBe('processed');
  });
});


/**
 * Retrying a refund, without either paying twice or charging nobody.
 *
 * Two opposite failures meet on this path, and a fix for one is the other bug
 * if the attempt number is derived from the wrong thing:
 *
 *   - Razorpay FAILED the refund. The money never moved, the shop's deduction
 *     has been reversed, and the retry must look new to both the gateway and
 *     the ledger — otherwise the gateway hands back the dead refund and the
 *     ledger dedupes the deduction away, so the student is never paid and the
 *     shop is never charged.
 *   - The gateway ACCEPTED the refund and the local transaction then failed to
 *     commit. The refund is real and in flight. The retry must look identical,
 *     or Razorpay issues a second one and the student is refunded twice.
 *
 * `attempts` counts failures rather than starts, which is what tells the two
 * apart: only the first advances it.
 */
describe('Retrying a refund', () => {
  /** The idempotency key presented to Razorpay on the nth call. */
  const gatewayKey = (call = 0) =>
    ((global.fetch as jest.Mock).mock.calls[call][1].headers as Record<string, string>)[
      'X-Refund-Idempotency'
    ];

  /** The eventId of the shop's REFUND_DEDUCTION, if one was written. */
  const deductionEventId = () =>
    mockCreateLedgerEntry.mock.calls.find((c) => c[0]?.type === 'REFUND_DEDUCTION')?.[0]?.eventId;

  beforeEach(() => {
    // A share worth deducting, so the ledger write actually happens.
    mockShopShareOfRefund.mockResolvedValue(12500);
  });

  test('a first attempt presents the bare request id', async () => {
    // Unchanged from before retries existed, so a refund already in flight at
    // the gateway keeps answering to the key it was created with.
    await settle();

    expect(gatewayKey()).toBe('refund_1');
    expect(deductionEventId()).toBe('refund:refund_1');
  });

  test('an attempt that lost its transaction retries under the same key', async () => {
    // The gateway call succeeded and the commit did not, so `attempts` never
    // advanced and no refund id was stored. Presenting the same key is what
    // makes Razorpay return the refund it already made instead of a second one.
    mockRefundFindUnique.mockResolvedValue(claimedRequest({ attempts: 0, razorpayRefundId: null }));

    await settle();

    expect(gatewayKey()).toBe('refund_1');
  });

  test('a retry after a failed attempt presents a new key', async () => {
    // One failure recorded, so this is attempt 2 and must look new — the same
    // key would return the refund Razorpay has already failed.
    mockRefundFindUnique.mockResolvedValue(claimedRequest({ attempts: 1 }));

    await settle();

    expect(gatewayKey()).toBe('refund_1-retry-2');
  });

  test('every key Razorpay is sent is one Razorpay will accept', async () => {
    // Razorpay constrains X-Refund-Idempotency to at least 10 characters of
    // letters, digits, hyphens and underscores. A colon separator reads better
    // and is what the ledger's own event ids use — and it would have been
    // rejected on every retry, so the retry would fail at the gateway instead
    // of issuing the refund. Real request ids are 25-character cuids, so only
    // the separator is at risk here; this asserts the shape rather than
    // trusting it.
    const razorpayAccepts = /^[A-Za-z0-9_-]{10,}$/;

    for (const attempts of [0, 1, 2, 9]) {
      (global.fetch as jest.Mock).mockClear();
      mockRefundFindUnique.mockResolvedValue(
        // Padded to a realistic cuid length; the id itself clears the floor.
        claimedRequest({ attempts, id: 'clx1a2b3c4d5e6f7g8h9i0j1k' })
      );

      await settleClaimedRefund('refund_1', { setOrderRefunded: true, createdBy: 'ADMIN' });

      expect(gatewayKey()).toMatch(razorpayAccepts);
    }
  });

  test("a retry after a failed attempt writes its own ledger entry", async () => {
    // The first attempt's deduction was reversed when it failed. Reusing its
    // eventId here would be deduped by `createLedgerEntry` and the shop would
    // keep money it has given back — the platform absorbing the whole refund.
    mockRefundFindUnique.mockResolvedValue(claimedRequest({ attempts: 1 }));

    await settle();

    expect(deductionEventId()).toBe('refund:refund_1:2');
  });

  test('the gateway is not called again for a refund already in flight', async () => {
    // A stored refund id means an earlier attempt reached Razorpay and is
    // waiting on a webhook. Calling again would be a second refund.
    mockRefundFindUnique.mockResolvedValue(claimedRequest({ razorpayRefundId: 'rfnd_inflight' }));

    await settle();

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

/**
 * The endpoint no longer takes an amount.
 *
 * `resolveRefundSchema` accepted a partial `refundAmount` that the rest of the
 * system could not honour: the order was marked fully REFUNDED whatever came
 * back, revenue lost the whole page cost, and the remainder could never be
 * refunded afterwards because `RefundRequest.orderId` is unique and the ledger
 * event id keys on an attempt number that only advances on a gateway failure.
 *
 * Nothing in the app ever sent one — every UI reference reads it back for
 * display — so removing it closes a state that was only reachable by hand.
 */
describe('resolveRefundSchema', () => {
  const parse = (body: Record<string, unknown>) =>
    resolveRefundSchema.safeParse({ body });

  const valid = { action: 'APPROVE', otp: '123456' };

  test('an ordinary approval still parses', () => {
    expect(parse(valid).success).toBe(true);
  });

  test('a refundAmount is stripped rather than honoured', () => {
    // Zod strips unknown keys, and `validate` writes the parsed body back — so
    // a caller sending one gets a full refund, not a partial one.
    const result = resolveRefundSchema.safeParse({ body: { ...valid, refundAmount: 100 } });

    expect(result.success).toBe(true);
    expect(result.success && 'refundAmount' in result.data.body).toBe(false);
  });

  test('the OTP is still required', () => {
    expect(parse({ action: 'APPROVE' }).success).toBe(false);
  });

  test('a denial still parses', () => {
    expect(parse({ action: 'DENY', otp: '123456', adminNote: 'not eligible' }).success).toBe(true);
  });
});
