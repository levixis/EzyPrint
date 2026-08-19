/**
 * A settings update must not be able to write a shop's money or its approval.
 *
 * `shop.controller` builds its payload as `{ ...req.body }`, and `validate`
 * parses a request to reject bad input without ever writing the parsed body
 * back — so Zod's stripping of unknown keys never reaches the service and
 * anything the caller sends is in scope. `Shop` holds `ledgerBalance`,
 * `pendingBalance`, `debtAmount`, `isApproved` and `financialVersion` as
 * ordinary columns, so a shop owner could PATCH their own shop with
 *
 *     { "isOpen": true, "ledgerBalance": 999999, "debtAmount": 0, "isApproved": true }
 *
 * and Prisma would write all four: an arbitrary withdrawable balance, their
 * debt to the platform cleared, and their shop approved past the admin review
 * that gates it. `ledgerBalance` is what payouts draw from, so that is a direct
 * route from a settings form to real money leaving the platform.
 *
 * The allowlist in `updateShopSettings` is the control. It is asserted here
 * rather than at the schema, because the schema is not what holds — the same
 * request reaching the service by any other route must be just as safe.
 */

const mockShopFindUnique = jest.fn();
const mockShopUpdate = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    shop: { findUnique: mockShopFindUnique, update: mockShopUpdate },
    $transaction: (fn: (tx: unknown) => unknown) => fn({
      shop: { update: mockShopUpdate },
      payoutMethod: { deleteMany: jest.fn(), createMany: jest.fn() },
    }),
  },
}));

import { updateShopSettings } from '../services/shop.service';

const OWNER = 'owner_1';

beforeEach(() => {
  jest.clearAllMocks();
  mockShopFindUnique.mockResolvedValue({ id: 'shop_1', ownerUserId: OWNER });
  mockShopUpdate.mockResolvedValue({ id: 'shop_1' });
});

/** The fields the service actually asked Prisma to write. */
const written = () => mockShopUpdate.mock.calls[0][0].data;

describe('a shop owner cannot write its own financial state', () => {
  const financial = {
    ledgerBalance: 999_999,
    pendingBalance: 999_999,
    debtAmount: 0,
    financialVersion: 0,
  };

  test('balances and debt are ignored', async () => {
    await updateShopSettings('shop_1', OWNER, { isOpen: true, ...financial } as never);

    const data = written();
    expect(data.ledgerBalance).toBeUndefined();
    expect(data.pendingBalance).toBeUndefined();
    expect(data.debtAmount).toBeUndefined();
    // Writing this directly would also defeat the compare-and-swap that stops
    // two concurrent ledger writes applying to the same starting balance.
    expect(data.financialVersion).toBeUndefined();
  });

  test('a shop cannot approve itself', async () => {
    await updateShopSettings('shop_1', OWNER, { isApproved: true, isRejected: false } as never);

    expect(written().isApproved).toBeUndefined();
    expect(written().isRejected).toBeUndefined();
  });

  test('a shop cannot un-archive itself', async () => {
    // Archival is an admin decision with an appeal path behind it; reversing it
    // from a settings form would route around that entirely.
    await updateShopSettings('shop_1', OWNER, { isArchived: false } as never);

    expect(written().isArchived).toBeUndefined();
  });

  test('a shop cannot reassign itself to another owner', async () => {
    await updateShopSettings('shop_1', OWNER, { ownerUserId: 'someone_else' } as never);

    expect(written().ownerUserId).toBeUndefined();
  });

  test('the real settings still save', async () => {
    // The allowlist must not be so tight that the form stops working.
    await updateShopSettings('shop_1', OWNER, {
      bwPerPage: 150,
      colorPerPage: 400,
      isOpen: false,
      contactPhone: '9999999999',
      contactPhoneAlt: '8888888888',
      contactEmail: 'shop@example.com',
      whatsappNumber: '7777777777',
    });

    expect(written()).toEqual({
      bwPerPage: 150,
      colorPerPage: 400,
      isOpen: false,
      contactPhone: '9999999999',
      contactPhoneAlt: '8888888888',
      contactEmail: 'shop@example.com',
      whatsappNumber: '7777777777',
    });
  });

  test('an admin is bound by the same allowlist', async () => {
    // The admin flag exists to bypass the ownership check, not to turn a
    // settings endpoint into one that can move money. Admins credit a shop
    // through the ledger, which records who did it and why.
    mockShopFindUnique.mockResolvedValue({ id: 'shop_1', ownerUserId: 'someone_else' });

    await updateShopSettings('shop_1', 'admin_1', { isOpen: true, ...financial } as never, true);

    expect(written().ledgerBalance).toBeUndefined();
    expect(written().debtAmount).toBeUndefined();
  });
});
