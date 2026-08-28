/**
 * A Student Pass purchase has a row, and the row is what makes a second charge
 * impossible rather than unlikely.
 *
 * BUG-037 fixed the *harm* — a second capture stacks instead of overwriting —
 * and a first follow-up added a TTL-bounded claim on `users`. Both left the
 * cause standing: a pass purchase had nothing to attach a guarantee to. A print
 * order cannot be paid for twice because of two things on its row, the
 * compare-and-swap on `paymentAttemptedAt` and the unique `razorpayOrderId`,
 * and a pass had neither.
 *
 * `StudentPassPurchase` is that row. Three properties replace the claim:
 *
 *   1. an open checkout is *returned*, not refused — one gateway order means one
 *      possible capture, which is stronger than a lock and better to use;
 *   2. a stale checkout is asked about at the gateway before anything new is
 *      minted, so a late UPI collect is adopted rather than charged again;
 *   3. the insert is serialised by a partial unique index, so two concurrent
 *      requests cannot both open a checkout — with no timer to expire and no
 *      timestamps to collide.
 */

interface PurchaseRow {
  id: string;
  userId: string;
  status: 'OPEN' | 'PAID' | 'ABANDONED' | 'REFUSED';
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  amountPaise: number;
  expiresAt: Date;
  appliedFrom: Date | null;
  refusedReason: string | null;
  createdAt: Date;
}

interface UserRow {
  id: string;
  type: string;
  hasStudentPass: boolean;
  studentPassActivatedAt: Date | null;
  studentPassPaymentId: string | null;
}

let purchases: PurchaseRow[];
let user: UserRow;
let seq: number;

/**
 * A stand-in for the partial unique index on `userId WHERE status = 'OPEN'`.
 *
 * Modelled rather than mocked away, because it is the entire mechanism. A
 * create that would produce a second open row for one user throws the same
 * P2002 Postgres would, which is what the service's catch is written against.
 */
const insertPurchase = (data: Partial<PurchaseRow> & { userId: string }): PurchaseRow => {
  if (purchases.some((p) => p.userId === data.userId && p.status === 'OPEN')) {
    throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  }
  const rowNow = new Date();
  const created: PurchaseRow = {
    id: `purchase_${++seq}`,
    status: 'OPEN',
    razorpayOrderId: null,
    razorpayPaymentId: null,
    amountPaise: 4900,
    expiresAt: rowNow,
    appliedFrom: null,
    refusedReason: null,
    createdAt: rowNow,
    ...data,
  } as PurchaseRow;
  purchases.push(created);
  return created;
};

/** The handful of Prisma predicates this service actually writes. */
const matches = (p: PurchaseRow, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([key, want]) => {
    const have = p[key as keyof PurchaseRow];
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      const filter = want as Record<string, unknown>;
      if ('in' in filter) return (filter.in as unknown[]).includes(have);
      if ('not' in filter) return have !== filter.not;
      if ('lt' in filter) return (have as Date) < (filter.lt as Date);
      if ('gte' in filter) return (have as Date) >= (filter.gte as Date);
    }
    return have === want;
  });

const mockPurchaseCreate = jest.fn(async ({ data }: { data: Partial<PurchaseRow> & { userId: string } }) =>
  insertPurchase(data)
);
const mockPurchaseFindFirst = jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
  purchases.find((p) => matches(p, where)) ?? null
);
const mockPurchaseFindUnique = jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
  purchases.find((p) => matches(p, where)) ?? null
);
const mockPurchaseUpdateMany = jest.fn(
  async ({ where, data }: { where: Record<string, unknown>; data: Partial<PurchaseRow> }) => {
    const hit = purchases.filter((p) => matches(p, where));
    hit.forEach((p) => Object.assign(p, data));
    return { count: hit.length };
  }
);
const mockPurchaseUpdate = jest.fn(
  async ({ where, data }: { where: { id: string }; data: Partial<PurchaseRow> }) => {
    const hit = purchases.find((p) => p.id === where.id)!;
    Object.assign(hit, data);
    return hit;
  }
);

const mockUserFindUnique = jest.fn(async () => user);
const mockUserUpdateMany = jest.fn(async ({ data }: { data: Partial<UserRow> }) => {
  Object.assign(user, data);
  return { count: 1 };
});

const mockOrdersCreate = jest.fn();
const mockOrdersFetch = jest.fn();
const mockOrdersFetchPayments = jest.fn();
const mockNotifyAdmins = jest.fn();

const purchaseClient = () => ({
  create: mockPurchaseCreate,
  findFirst: mockPurchaseFindFirst,
  findUnique: mockPurchaseFindUnique,
  updateMany: mockPurchaseUpdateMany,
  update: mockPurchaseUpdate,
});

jest.mock('../utils/prisma', () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique, updateMany: mockUserUpdateMany },
    studentPassPurchase: purchaseClient(),
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        user: { findUnique: mockUserFindUnique, updateMany: mockUserUpdateMany },
        studentPassPurchase: purchaseClient(),
      }),
  },
}));

jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { create: mockOrdersCreate, fetch: mockOrdersFetch, fetchPayments: mockOrdersFetchPayments },
  }))
);

jest.mock('../services/notify.service', () => ({ notifyAdmins: mockNotifyAdmins, notifyNewOrder: jest.fn() }));
jest.mock('../services/ledger.service', () => ({}));
jest.mock('../services/realtime.service', () => ({ publishQueued: jest.fn() }));
jest.mock('../services/order.service', () => ({}));

import {
  createStudentPassOrder,
  applyPassCapture,
  applyLegacyPassCapture,
  abandonExpiredPassCheckouts,
  PASS_CHECKOUT_EXPIRY_MS,
} from '../services/payment.service';
import { PASS_DURATION_MS } from '../services/pricing.service';

const PRICE = 4900;

beforeEach(() => {
  jest.clearAllMocks();
  seq = 0;
  purchases = [];
  user = {
    id: 'student_1',
    type: 'STUDENT',
    hasStudentPass: false,
    studentPassActivatedAt: null,
    studentPassPaymentId: null,
  };
  mockOrdersCreate.mockImplementation(async () => ({ id: `order_rzp_${purchases.length}` }));
  mockOrdersFetch.mockResolvedValue({ status: 'created' });
  mockOrdersFetchPayments.mockResolvedValue({ items: [] });
});

const openPurchase = () => purchases.find((p) => p.status === 'OPEN');

describe('one open checkout, enforced by the database', () => {
  test('the first purchase opens one and records its gateway order', async () => {
    const result = await createStudentPassOrder('student_1');

    expect(purchases).toHaveLength(1);
    expect(openPurchase()?.razorpayOrderId).toBe(result.razorpayOrderId);
  });

  test('tapping again returns the same checkout rather than refusing', async () => {
    // Better than a 400, and a stronger guarantee: one gateway order means one
    // possible capture, because Razorpay will not let an order be paid twice.
    const first = await createStudentPassOrder('student_1');
    const second = await createStudentPassOrder('student_1');

    expect(second.razorpayOrderId).toBe(first.razorpayOrderId);
    expect(second.paid).toBeUndefined();
  });

  test('and mints nothing new when it does', async () => {
    await createStudentPassOrder('student_1');
    await createStudentPassOrder('student_1');

    expect(mockOrdersCreate).toHaveBeenCalledTimes(1);
    expect(purchases).toHaveLength(1);
  });

  test('two concurrent requests produce exactly one gateway order', async () => {
    // The double-tap, raced rather than sequenced. Both read a user with no
    // active pass; the partial unique index is what decides, not a timer.
    const results = await Promise.all([
      createStudentPassOrder('student_1'),
      createStudentPassOrder('student_1').catch((e: Error) => e),
    ]);

    const orders = new Set(
      results.flatMap((r) => (r instanceof Error ? [] : [r.razorpayOrderId]))
    );

    expect(mockOrdersCreate).toHaveBeenCalledTimes(1);
    expect(orders.size).toBe(1);
    expect(purchases.filter((p) => p.status === 'OPEN')).toHaveLength(1);
  });

  test('a concurrent loser never creates a second purchase row', async () => {
    await Promise.all([
      createStudentPassOrder('student_1'),
      createStudentPassOrder('student_1').catch(() => undefined),
    ]);

    expect(purchases).toHaveLength(1);
  });
});

describe('an expired checkout is asked about before it is replaced', () => {
  const expire = () => {
    const open = openPurchase()!;
    open.expiresAt = new Date(Date.now() - 1000);
  };

  test('an unpaid one is abandoned and a fresh checkout minted', async () => {
    await createStudentPassOrder('student_1');
    expire();

    const result = await createStudentPassOrder('student_1');

    expect(purchases).toHaveLength(2);
    expect(purchases[0].status).toBe('ABANDONED');
    expect(result.razorpayOrderId).not.toBe(purchases[0].razorpayOrderId);
  });

  test('the abandoned row is kept, not deleted', async () => {
    // A Razorpay order outlives our idea of it. A capture arriving later still
    // has to find the purchase it belongs to.
    await createStudentPassOrder('student_1');
    const firstOrderId = openPurchase()!.razorpayOrderId;
    expire();
    await createStudentPassOrder('student_1');

    expect(purchases.find((p) => p.razorpayOrderId === firstOrderId)).toBeDefined();
  });

  test('one the student actually paid is adopted, not charged again', async () => {
    // The sequential case a TTL alone could never see: sheet dismissed, collect
    // approved twenty minutes later.
    await createStudentPassOrder('student_1');
    expire();
    mockOrdersFetch.mockResolvedValue({ status: 'paid' });
    mockOrdersFetchPayments.mockResolvedValue({
      items: [{ id: 'pay_late', status: 'captured', amount: PRICE }],
    });

    const result = await createStudentPassOrder('student_1');

    expect(result.paid).toBe(true);
    expect(user.hasStudentPass).toBe(true);
    expect(mockOrdersCreate).toHaveBeenCalledTimes(1);
  });

  test('adopting marks the purchase paid rather than abandoned', async () => {
    await createStudentPassOrder('student_1');
    expire();
    mockOrdersFetch.mockResolvedValue({ status: 'paid' });
    mockOrdersFetchPayments.mockResolvedValue({
      items: [{ id: 'pay_late', status: 'captured', amount: PRICE }],
    });

    await createStudentPassOrder('student_1');

    expect(purchases[0].status).toBe('PAID');
    expect(purchases[0].razorpayPaymentId).toBe('pay_late');
  });

  test('a gateway lookup that fails still lets the student buy', async () => {
    // Fails open, unlike the order path. There the cost of guessing wrong is a
    // paid student's file deleted; here it is a second gateway order, which the
    // capture path reconciles against its own row and stacks.
    await createStudentPassOrder('student_1');
    expire();
    mockOrdersFetch.mockRejectedValue(new Error('razorpay unreachable'));

    const result = await createStudentPassOrder('student_1');

    expect(result.razorpayOrderId).toBeDefined();
    expect(result.paid).toBeUndefined();
  });

  test('paid-but-no-capture is refused rather than replaced', async () => {
    // Money is somewhere in that gap, so this is not a green light to charge again.
    await createStudentPassOrder('student_1');
    expire();
    mockOrdersFetch.mockResolvedValue({ status: 'paid' });
    mockOrdersFetchPayments.mockResolvedValue({ items: [] });

    await expect(createStudentPassOrder('student_1')).rejects.toThrow(/do not pay again/i);
    expect(purchases[0].status).toBe('REFUSED');
    expect(mockNotifyAdmins).toHaveBeenCalled();
  });
});

describe('a failure while minting gives the slot back', () => {
  test('a gateway error abandons the purchase', async () => {
    mockOrdersCreate.mockRejectedValue(new Error('razorpay unreachable'));

    await expect(createStudentPassOrder('student_1')).rejects.toThrow('razorpay unreachable');

    expect(purchases[0].status).toBe('ABANDONED');
  });

  test('so the student can retry immediately', async () => {
    mockOrdersCreate.mockRejectedValueOnce(new Error('razorpay unreachable'));

    await createStudentPassOrder('student_1').catch(() => undefined);
    const result = await createStudentPassOrder('student_1');

    expect(result.razorpayOrderId).toBeDefined();
  });

  test('a failure recording the gateway order also abandons it', async () => {
    mockPurchaseUpdate.mockRejectedValueOnce(new Error('write failed'));

    await expect(createStudentPassOrder('student_1')).rejects.toThrow('write failed');

    expect(purchases[0].status).toBe('ABANDONED');
  });
});

describe('the cheaper checks still run first, and open nothing', () => {
  test('an active pass is refused without a purchase row', async () => {
    user.hasStudentPass = true;
    user.studentPassActivatedAt = new Date();

    await expect(createStudentPassOrder('student_1')).rejects.toThrow(/still active/i);

    expect(purchases).toHaveLength(0);
  });

  test('a non-student is refused without a purchase row', async () => {
    user.type = 'SHOP_OWNER';

    await expect(createStudentPassOrder('student_1')).rejects.toThrow(/Only students/i);

    expect(purchases).toHaveLength(0);
  });
});

describe('stacking still applies to whatever gets through', () => {
  test('a late capture on an abandoned checkout extends rather than resets', async () => {
    // The fallback is unchanged and still load-bearing: the student paid for
    // those days and must receive them.
    user.hasStudentPass = true;
    user.studentPassActivatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    insertPurchase({ userId: 'student_1', status: 'ABANDONED', razorpayOrderId: 'order_old', amountPaise: PRICE });

    const before = user.studentPassActivatedAt.getTime();
    await applyPassCapture('purchase_1', 'pay_late', PRICE, 'student_1');

    expect(user.studentPassActivatedAt!.getTime()).toBe(before + PASS_DURATION_MS);
    expect(purchases[0].status).toBe('PAID');
  });

  test('and the double charge is reported to the admins', async () => {
    user.hasStudentPass = true;
    user.studentPassActivatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    insertPurchase({ userId: 'student_1', status: 'ABANDONED', razorpayOrderId: 'order_old', amountPaise: PRICE });

    await applyPassCapture('purchase_1', 'pay_late', PRICE, 'student_1');

    expect(mockNotifyAdmins).toHaveBeenCalledWith(expect.stringMatching(/charged twice/i), 'warning');
  });
});

describe('the amount is judged against what this checkout quoted', () => {
  test('a price change mid-checkout does not refuse a good payment', async () => {
    // The old check compared against `env.STUDENT_PASS_PRICE_PAISE`, so raising
    // the price while a checkout was open turned a correct payment into a
    // refusal — charging a real student and delivering nothing.
    insertPurchase({ userId: 'student_1', status: 'OPEN', razorpayOrderId: 'order_1', amountPaise: 3900 });

    const outcome = await applyPassCapture('purchase_1', 'pay_1', 3900, 'student_1');

    expect(outcome.applied).toBe(true);
    expect(user.hasStudentPass).toBe(true);
  });

  test('a genuinely wrong sum is refused, recorded and escalated', async () => {
    insertPurchase({ userId: 'student_1', status: 'OPEN', razorpayOrderId: 'order_1', amountPaise: PRICE });

    const outcome = await applyPassCapture('purchase_1', 'pay_1', 100, 'student_1');

    expect(outcome.applied).toBe(false);
    expect(user.hasStudentPass).toBe(false);
    expect(purchases[0].status).toBe('REFUSED');
    expect(purchases[0].refusedReason).toMatch(/quoted/);
    expect(mockNotifyAdmins).toHaveBeenCalledWith(expect.stringMatching(/refused/i), 'error');
  });

  test('a redelivered capture applies nothing a second time', async () => {
    insertPurchase({ userId: 'student_1', status: 'OPEN', razorpayOrderId: 'order_1', amountPaise: PRICE });

    await applyPassCapture('purchase_1', 'pay_1', PRICE, 'student_1');
    const firstWindow = user.studentPassActivatedAt!.getTime();

    await applyPassCapture('purchase_1', 'pay_1', PRICE, 'student_1');

    expect(user.studentPassActivatedAt!.getTime()).toBe(firstWindow);
  });
});

describe('the expiry sweep', () => {
  test('abandons an expired open checkout', async () => {
    insertPurchase({ userId: 'student_1', expiresAt: new Date(Date.now() - 1000) });

    expect(await abandonExpiredPassCheckouts()).toBe(1);
    expect(purchases[0].status).toBe('ABANDONED');
  });

  test('leaves a live one alone', async () => {
    insertPurchase({ userId: 'student_1', expiresAt: new Date(Date.now() + 60_000) });

    expect(await abandonExpiredPassCheckouts()).toBe(0);
    expect(purchases[0].status).toBe('OPEN');
  });
});

describe('the checkout window', () => {
  test('is generous, because it is no longer a lock', () => {
    // While it holds, the student is handed the same order back rather than
    // refused, so a long window costs them nothing and buys the guarantee that
    // only one gateway order exists.
    expect(PASS_CHECKOUT_EXPIRY_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  test('but still bounded, so an abandoned checkout does not linger', () => {
    expect(PASS_CHECKOUT_EXPIRY_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});

describe('a checkout minted before this table existed', () => {
  /**
   * The deploy window, which is the one way a capture can arrive with no
   * purchase row. Refusing it would charge a student and give them nothing for
   * the crime of being mid-checkout while we shipped — and the old code would
   * have activated them.
   */
  test('is still honoured', async () => {
    const outcome = await applyLegacyPassCapture('student_1', 'pay_legacy', PRICE);

    expect(outcome.applied).toBe(true);
    expect(user.hasStudentPass).toBe(true);
    expect(user.studentPassPaymentId).toBe('pay_legacy');
  });

  test('and reported, so it does not pass unnoticed', async () => {
    await applyLegacyPassCapture('student_1', 'pay_legacy', PRICE);

    expect(mockNotifyAdmins).toHaveBeenCalledWith(
      expect.stringMatching(/no purchase record/i),
      'warning'
    );
  });

  test('but a wrong sum is still refused', async () => {
    // The legacy path keeps the check it was minted under; it does not become a
    // way to activate anything that arrives without a row.
    const outcome = await applyLegacyPassCapture('student_1', 'pay_legacy', 100);

    expect(outcome.applied).toBe(false);
    expect(user.hasStudentPass).toBe(false);
    expect(mockNotifyAdmins).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  test('and it still stacks rather than resetting', async () => {
    user.hasStudentPass = true;
    user.studentPassActivatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const before = user.studentPassActivatedAt.getTime();

    await applyLegacyPassCapture('student_1', 'pay_legacy', PRICE);

    expect(user.studentPassActivatedAt!.getTime()).toBe(before + PASS_DURATION_MS);
  });
});
