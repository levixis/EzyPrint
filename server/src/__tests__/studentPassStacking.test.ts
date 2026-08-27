/**
 * A second Student Pass payment must buy days, not replace them.
 *
 * A pass has no local row to claim — unlike a print order, which is protected by
 * the `paymentAttemptedAt` claim and the unique `Order.razorpayOrderId`. So
 * nothing dedupes two open pass checkouts: dismiss the sheet, tap again, pay by
 * card, and then approve the first UPI collect an hour later. Two captures.
 *
 * `activateStudentPass` then overwrote `studentPassActivatedAt` with the current
 * time for any payment id it had not seen. ₹98 charged, thirty days delivered —
 * and no trace of the first payment anywhere, because the column that held its id
 * had just been overwritten and `auditCapturedPayments` skips pass payments by
 * design.
 *
 * The window now starts where the live one ends.
 */

const mockUserFindUnique = jest.fn();
const mockUserUpdateMany = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique, updateMany: mockUserUpdateMany },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({ user: { findUnique: mockUserFindUnique, updateMany: mockUserUpdateMany } }),
  },
}));

jest.mock('../services/notify.service', () => ({ notifyAdmins: jest.fn(), notifyNewOrder: jest.fn() }));
jest.mock('../services/ledger.service', () => ({}));
jest.mock('../services/realtime.service', () => ({ publishQueued: jest.fn() }));
jest.mock('../services/order.service', () => ({}));
jest.mock('razorpay', () => jest.fn().mockImplementation(() => ({ orders: {} })));

import { activateStudentPass } from '../services/payment.service';
import { PASS_DURATION_MS } from '../services/pricing.service';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  jest.clearAllMocks();
  mockUserUpdateMany.mockResolvedValue({ count: 1 });
});

/** What the service asked Prisma to write. */
const written = () => mockUserUpdateMany.mock.calls[0][0].data;

describe('a first purchase', () => {
  test('starts the window now', async () => {
    mockUserFindUnique.mockResolvedValue({
      hasStudentPass: false,
      studentPassActivatedAt: null,
      studentPassPaymentId: null,
    });

    const before = Date.now();
    const result = await activateStudentPass('student_1', 'pay_1');

    expect(result.activated).toBe(true);
    expect(result.stacked).toBe(false);
    expect(written().hasStudentPass).toBe(true);
    expect(written().studentPassActivatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('a renewal after expiry', () => {
  test('starts a fresh window from now, not from the old expiry', async () => {
    // The pass lapsed a week ago. Extending from the dead expiry would hand the
    // student a window that had already partly elapsed.
    const expiredStart = new Date(Date.now() - PASS_DURATION_MS - 7 * DAY);
    mockUserFindUnique.mockResolvedValue({
      hasStudentPass: true,
      studentPassActivatedAt: expiredStart,
      studentPassPaymentId: 'pay_old',
    });

    const before = Date.now();
    const result = await activateStudentPass('student_1', 'pay_2');

    expect(result.stacked).toBe(false);
    expect(written().studentPassActivatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('a second payment while a pass is still live', () => {
  test('extends from the current expiry instead of resetting', async () => {
    // Ten days in: twenty days remain. The student paid for thirty more, so they
    // should end up with fifty — not thirty.
    const activatedAt = new Date(Date.now() - 10 * DAY);
    mockUserFindUnique.mockResolvedValue({
      hasStudentPass: true,
      studentPassActivatedAt: activatedAt,
      studentPassPaymentId: 'pay_1',
    });

    const result = await activateStudentPass('student_1', 'pay_2');

    expect(result.stacked).toBe(true);
    // The new window begins exactly where the old one ended.
    expect(written().studentPassActivatedAt.getTime()).toBe(activatedAt.getTime() + PASS_DURATION_MS);
  });

  test('the student is never left with fewer days than they had', async () => {
    const activatedAt = new Date(Date.now() - 10 * DAY);
    mockUserFindUnique.mockResolvedValue({
      hasStudentPass: true,
      studentPassActivatedAt: activatedAt,
      studentPassPaymentId: 'pay_1',
    });

    await activateStudentPass('student_1', 'pay_2');

    const oldExpiry = activatedAt.getTime() + PASS_DURATION_MS;
    const newExpiry = written().studentPassActivatedAt.getTime() + PASS_DURATION_MS;

    expect(newExpiry).toBeGreaterThan(oldExpiry);
    expect(newExpiry - oldExpiry).toBe(PASS_DURATION_MS);
  });

  test('and it is reported, because they have been charged twice', async () => {
    // Nothing else can surface this: a pass has no order row, and the orphan
    // audit skips pass payments. `stacked` is what reaches the admins.
    mockUserFindUnique.mockResolvedValue({
      hasStudentPass: true,
      studentPassActivatedAt: new Date(Date.now() - 10 * DAY),
      studentPassPaymentId: 'pay_1',
    });

    expect((await activateStudentPass('student_1', 'pay_2')).stacked).toBe(true);
  });
});

describe('idempotency is unchanged', () => {
  test('the same payment id twice changes nothing', async () => {
    // A verify call racing its own webhook must not grant two windows.
    mockUserFindUnique.mockResolvedValue({
      hasStudentPass: true,
      studentPassActivatedAt: new Date(Date.now() - DAY),
      studentPassPaymentId: 'pay_1',
    });

    const result = await activateStudentPass('student_1', 'pay_1');

    expect(result.activated).toBe(false);
    expect(result.stacked).toBe(false);
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });

  test('the null arm of the guard survives — a first-time buyer still matches', async () => {
    // `{ not: x }` compiles to a SQL inequality, and NULL <> 'x' is NULL rather
    // than true, so a column never set matches nothing. Without the null arm the
    // guard excludes exactly the case it exists to allow.
    mockUserFindUnique.mockResolvedValue({
      hasStudentPass: false,
      studentPassActivatedAt: null,
      studentPassPaymentId: null,
    });

    await activateStudentPass('student_1', 'pay_1');

    expect(mockUserUpdateMany.mock.calls[0][0].where.OR).toEqual([
      { studentPassPaymentId: null },
      { studentPassPaymentId: { not: 'pay_1' } },
    ]);
  });

  test('a user that no longer exists is not activated', async () => {
    mockUserFindUnique.mockResolvedValue(null);

    const result = await activateStudentPass('gone', 'pay_1');

    expect(result.activated).toBe(false);
    expect(mockUserUpdateMany).not.toHaveBeenCalled();
  });
});

describe('the read and the write share a transaction', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '../services/payment.service.ts'),
    'utf8'
  );
  const fn: string = source.slice(
    source.indexOf('export async function activateStudentPass'),
    source.indexOf('export async function verifyStudentPassPayment')
  );

  test('so two captures arriving together cannot both extend from the same expiry', () => {
    // A read-then-write outside a transaction is how "extend from current expiry"
    // becomes "both extend from the same current expiry", which grants sixty days
    // for two payments that should have granted sixty — but only by luck, and
    // ninety for three.
    //
    // Both statements go through the same `tx`, whether that transaction was
    // opened here or handed in by `applyPassCapture`.
    expect(fn).toContain('tx.user.findUnique');
    expect(fn).toContain('tx.user.updateMany');
  });

  test('and it joins the caller\'s transaction when given one', () => {
    // `applyPassCapture` passes its own, so marking the purchase PAID and
    // applying the pass commit together. A purchase recorded as paid against a
    // student whose pass never moved is the worst of both records.
    expect(fn).toContain('txClient ? execute(txClient) : prisma.$transaction(execute)');
  });

  test('and never reaches past it to the bare client', () => {
    // A single `prisma.` inside the body would be a write outside the
    // transaction the rest of the function is relying on.
    const body = fn.slice(fn.indexOf('const execute'), fn.indexOf('return txClient'));

    expect(body).not.toContain('prisma.user');
  });
});
