/**
 * Checking Razorpay against our own database, rather than the other way round.
 *
 * `reconcilePayments` starts from orders we know are stuck and asks the gateway
 * about them. It cannot see an order that is not in the table, and on
 * 2026-08-03 that was not hypothetical: a database restore rolled production
 * back past a ₹5 order that had already been paid, printed and completed. The
 * row, its files and its ledger entry all went at once.
 *
 * Nothing internal noticed, and nothing internal could have. The ledger still
 * reconciled to the paise — an earning removed together with the order it
 * belonged to leaves the books balanced, just describing a smaller business.
 * Only Razorpay still knew the money had been taken.
 *
 * So these tests are about the one question our own data cannot answer: for
 * every payment the gateway captured, do we have an order?
 */

const mockOrderFindFirst = jest.fn();
const mockPassFindUnique = jest.fn();
const mockPassFindFirst = jest.fn();
const mockPaymentsAll = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    order: { findFirst: mockOrderFindFirst },
    // Pass payments are audited now rather than skipped, so this suite has to
    // answer for the purchase table as well.
    studentPassPurchase: {
      findUnique: mockPassFindUnique,
      findFirst: mockPassFindFirst,
    },
  },
}));

jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    payments: { all: mockPaymentsAll },
    orders: { fetch: jest.fn(), fetchPayments: jest.fn(), create: jest.fn() },
  }))
);

jest.mock('../services/notify.service', () => ({ notifyAdmins: jest.fn(), notifyNewOrder: jest.fn() }));
jest.mock('../services/order.service', () => ({ repriceFromVerifiedPages: jest.fn() }));
jest.mock('../services/ledger.service', () => ({}));
jest.mock('../services/realtime.service', () => ({ publishQueued: jest.fn() }));

import { auditCapturedPayments } from '../services/payment.service';

const MINUTE = 60 * 1000;
const secondsAgo = (ms: number) => Math.floor((Date.now() - ms) / 1000);

/** The order that actually went missing, in the shape Razorpay returned it. */
const lostPayment = (overrides: Record<string, unknown> = {}) => ({
  id: 'pay_TL9pAqenmOMu8t',
  status: 'captured',
  amount: 500,
  order_id: 'order_TL9nyW5mix09cM',
  created_at: secondsAgo(60 * MINUTE),
  email: 'student@example.com',
  contact: '+910000000000',
  notes: { orderId: 'cmscpaa4m0007g72tat8vebab', shopId: 'shop_1' },
  ...overrides,
});

beforeEach(() => {
  mockOrderFindFirst.mockReset();
  mockPaymentsAll.mockReset();
  mockPassFindUnique.mockReset();
  mockPassFindFirst.mockReset();
  mockPaymentsAll.mockResolvedValue({ items: [] });
  mockPassFindUnique.mockResolvedValue(null);
  mockPassFindFirst.mockResolvedValue(null);
});

describe('a captured payment with no order', () => {
  test('is reported', async () => {
    mockPaymentsAll.mockResolvedValue({ items: [lostPayment()] });
    mockOrderFindFirst.mockResolvedValue(null);

    const result = await auditCapturedPayments();

    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]).toMatchObject({
      paymentId: 'pay_TL9pAqenmOMu8t',
      amountPaise: 500,
      claimedOrderId: 'cmscpaa4m0007g72tat8vebab',
      razorpayOrderId: 'order_TL9nyW5mix09cM',
    });
  });

  test('is looked for by payment id, by our order id, and by the gateway order id', async () => {
    // Any one of the three can be absent. The payment id is only written once
    // we process the capture — which by definition did not finish here — so a
    // lookup on that alone would report every genuine in-flight payment as
    // lost.
    mockPaymentsAll.mockResolvedValue({ items: [lostPayment()] });
    mockOrderFindFirst.mockResolvedValue(null);

    await auditCapturedPayments();

    const where = mockOrderFindFirst.mock.calls[0][0].where;
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { razorpayPaymentId: 'pay_TL9pAqenmOMu8t' },
        { id: 'cmscpaa4m0007g72tat8vebab' },
        { razorpayOrderId: 'order_TL9nyW5mix09cM' },
      ])
    );
  });

  test('is not reported when the order is present', async () => {
    mockPaymentsAll.mockResolvedValue({ items: [lostPayment()] });
    mockOrderFindFirst.mockResolvedValue({ id: 'cmscpaa4m0007g72tat8vebab' });

    const result = await auditCapturedPayments();

    expect(result.orphans).toHaveLength(0);
    expect(result.checked).toBe(1);
  });
});

describe('what the audit deliberately ignores', () => {
  test('payments that are not captured', async () => {
    // The failed Mobikwik attempt that preceded the real one. No money moved,
    // so there is nothing to account for.
    mockPaymentsAll.mockResolvedValue({
      items: [lostPayment({ id: 'pay_failed', status: 'failed' })],
    });

    const result = await auditCapturedPayments();

    expect(result.orphans).toHaveLength(0);
    expect(mockOrderFindFirst).not.toHaveBeenCalled();
  });

  test('a capture too recent to judge', async () => {
    // Captured 30 seconds ago: the request that records it may still be in
    // flight. Alerting here would page an admin about every payment in
    // progress, and an alert that fires constantly is one nobody reads.
    mockPaymentsAll.mockResolvedValue({
      items: [lostPayment({ created_at: secondsAgo(30 * 1000) })],
    });
    mockOrderFindFirst.mockResolvedValue(null);

    const result = await auditCapturedPayments();

    expect(result.orphans).toHaveLength(0);
    expect(result.skippedTooRecent).toBe(1);
    expect(result.checked).toBe(0);
  });

  test('a Student Pass payment that has its purchase row', async () => {
    // These used to be skipped outright — "not orders and have no order row by
    // design", which was true and was precisely why a double-charged pass was
    // invisible to the one check that walks from Razorpay inward. They have a
    // row now, so a matched one is accounted for like anything else.
    mockPaymentsAll.mockResolvedValue({
      items: [lostPayment({ id: 'pay_pass', notes: { userId: 'u_1', purchaseId: 'p_1', subscription_type: 'student_pass' } })],
    });
    mockPassFindUnique.mockResolvedValue({ id: 'p_1' });

    const result = await auditCapturedPayments();

    expect(result.orphans).toHaveLength(0);
  });

  test('a Student Pass payment from before the purchase table existed', async () => {
    // Indistinguishable from a genuine orphan by inspection, so the floor
    // decides: anything captured before the first purchase we ever recorded
    // predates the table and is not something a human can act on.
    mockPaymentsAll.mockResolvedValue({
      items: [lostPayment({ id: 'pay_old', notes: { userId: 'u_1', subscription_type: 'student_pass' } })],
    });
    mockPassFindUnique.mockResolvedValue(null);
    mockPassFindFirst.mockResolvedValue({ createdAt: new Date() }); // recorded after this payment

    const result = await auditCapturedPayments();

    expect(result.orphans).toHaveLength(0);
  });
});

describe('what the audit now catches that it could not before', () => {
  test('a Student Pass payment with no purchase behind it', async () => {
    // The double-charge this whole line of work is about. Before the purchase
    // table there was nothing to check against, so this was unreportable.
    mockPaymentsAll.mockResolvedValue({
      items: [lostPayment({ id: 'pay_orphan_pass', notes: { userId: 'u_1', subscription_type: 'student_pass' } })],
    });
    mockPassFindUnique.mockResolvedValue(null);
    mockPassFindFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) });

    const result = await auditCapturedPayments();

    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0].paymentId).toBe('pay_orphan_pass');
  });

  test('and reports nothing when no pass has ever been recorded', async () => {
    // No floor to compare against means no pass payment is auditable yet, which
    // is correct rather than an excuse to flag everything.
    mockPaymentsAll.mockResolvedValue({
      items: [lostPayment({ id: 'pay_pass', notes: { userId: 'u_1', subscription_type: 'student_pass' } })],
    });
    mockPassFindUnique.mockResolvedValue(null);
    mockPassFindFirst.mockResolvedValue(null);

    const result = await auditCapturedPayments();

    expect(result.orphans).toHaveLength(0);
  });
});

describe('paging', () => {
  test('follows a full page and stops on a short one', async () => {
    const full = Array.from({ length: 100 }, (_, i) =>
      lostPayment({ id: `pay_${i}`, notes: { orderId: `order_${i}` } })
    );
    mockPaymentsAll
      .mockResolvedValueOnce({ items: full })
      .mockResolvedValueOnce({ items: [lostPayment({ id: 'pay_last' })] });
    mockOrderFindFirst.mockResolvedValue({ id: 'exists' });

    const result = await auditCapturedPayments();

    expect(mockPaymentsAll).toHaveBeenCalledTimes(2);
    expect(mockPaymentsAll.mock.calls[1][0].skip).toBe(100);
    expect(result.checked).toBe(101);
  });

  test('asks only for the window it was given', async () => {
    await auditCapturedPayments({ windowMinutes: 120 });

    const from = mockPaymentsAll.mock.calls[0][0].from;
    const expected = Math.floor((Date.now() - 120 * MINUTE) / 1000);
    expect(Math.abs(from - expected)).toBeLessThan(5);
  });
});
