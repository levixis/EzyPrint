/**
 * Deleting an account must not destroy the orders the ledger refers to.
 *
 * `Order.user` is `onDelete: Cascade`, so `user.delete()` takes every order the
 * account ever placed. `LedgerEntry.orderId` is a plain column with no foreign
 * key, so the ledger rows survive — pointing at orders that no longer exist.
 * That is unrecoverable: the entry says a shop earned money for an order nobody
 * can produce, and no reconciliation against Razorpay can rebuild it.
 *
 * Separately, both delete paths cancelled live orders with a bare status write,
 * bypassing `claimCancellationRefund` — the mechanism that makes every other
 * cancellation return the money. A student with a paid, unprinted order could
 * delete their own account (a code to their own address is the only gate) and
 * the money was neither refunded to them nor credited to the shop.
 */

const mockOrderCount = jest.fn();
const mockOrderFindMany = jest.fn();
const mockLedgerCount = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    order: { count: mockOrderCount, findMany: mockOrderFindMany },
    ledgerEntry: { count: mockLedgerCount },
  },
}));

jest.mock('../services/email.service', () => ({ sendOTPEmail: jest.fn() }));
jest.mock('../services/otp.service', () => ({ issueOtp: jest.fn(), consumeOtp: jest.fn() }));

import { assertOrdersSafeToDelete } from '../routes/admin.routes';

beforeEach(() => {
  jest.clearAllMocks();
  mockOrderCount.mockResolvedValue(0);
  mockOrderFindMany.mockResolvedValue([]);
  mockLedgerCount.mockResolvedValue(0);
});

describe('assertOrdersSafeToDelete', () => {
  test('an account with no orders at all is deletable', async () => {
    await expect(assertOrdersSafeToDelete('user_1')).resolves.toBeUndefined();
  });

  test('a paid, unfulfilled order blocks the deletion', async () => {
    // The money has been taken and the print has not happened. Cancelling is
    // what refunds it, so the caller is told to do that first.
    mockOrderCount.mockResolvedValue(2);

    await expect(assertOrdersSafeToDelete('user_1')).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(assertOrdersSafeToDelete('user_1')).rejects.toThrow(/2 paid order/);
  });

  test('the live-order check looks at exactly the paid-but-unprinted states', async () => {
    // PENDING_PAYMENT and PAYMENT_FAILED are excluded on purpose: nothing was
    // charged, so there is nothing to give back.
    mockOrderCount.mockResolvedValue(0);
    await assertOrdersSafeToDelete('user_1');

    expect(mockOrderCount.mock.calls[0][0].where.status.in.sort()).toEqual(
      ['PENDING_APPROVAL', 'PRINTING', 'READY_FOR_PICKUP']
    );
  });

  test('an order a ledger entry names blocks the deletion', async () => {
    // This is the unrecoverable case: the order would cascade away and the
    // ledger row would stay, naming an order that no longer exists.
    mockOrderFindMany.mockResolvedValue([{ id: 'order_1' }, { id: 'order_2' }]);
    mockLedgerCount.mockResolvedValue(3);

    await expect(assertOrdersSafeToDelete('user_1')).rejects.toThrow(/3 financial record/);
  });

  test('orders with no ledger entries do not block it', async () => {
    // A student who only ever cancelled before paying has orders but no money
    // history, and should still be able to close their account.
    mockOrderFindMany.mockResolvedValue([{ id: 'order_1' }]);
    mockLedgerCount.mockResolvedValue(0);

    await expect(assertOrdersSafeToDelete('user_1')).resolves.toBeUndefined();
  });

  test('the refusal is permanent, so it must not cost the caller their OTP', async () => {
    /**
     * Not a property of this function but of where it is called from, and it
     * belongs with these tests because it is what makes the refusal usable.
     *
     * `consumeOtp` deletes the code atomically. An account whose orders the
     * ledger names will still be that way on the next attempt, so a refusal
     * thrown *after* the code was spent turns one clear answer into an endless
     * request-code / fail / request-code loop that reads as a broken OTP.
     * `/payouts/:id/cancel` established the check-then-consume ordering for
     * exactly this reason.
     *
     * Asserted on the source because the ordering is the invariant — mocking
     * the handler would pin the call sequence I happened to write rather than
     * the property that matters.
     */
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '../routes/admin.routes.ts'),
      'utf8'
    ) as string;

    const guardAt = source.indexOf('await assertOrdersSafeToDelete(caller.id)');
    const consumeAt = source.indexOf('await otpService.consumeOtp(caller.id, action, otp)');

    expect(guardAt).toBeGreaterThan(-1);
    expect(consumeAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(consumeAt);
  });

  test('the ledger lookup is scoped to this user’s orders, not the whole table', async () => {
    // Scoping matters: an unscoped count would block every deletion the moment
    // any shop anywhere had earned anything.
    mockOrderFindMany.mockResolvedValue([{ id: 'order_1' }, { id: 'order_2' }]);
    mockLedgerCount.mockResolvedValue(0);

    await assertOrdersSafeToDelete('user_1');

    expect(mockLedgerCount.mock.calls[0][0]).toEqual({
      where: { orderId: { in: ['order_1', 'order_2'] } },
    });
  });
});
