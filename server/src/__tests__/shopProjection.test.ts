/**
 * What a shop's record exposes, and to whom.
 *
 * `GET /shops/:shopId` had no authentication on it and returned the full shop
 * row — `pendingBalance`, `ledgerBalance`, `debtAmount` — plus the owner's
 * email and `payoutMethods`, which is where the bank account number, IFSC code
 * and UPI id live. Shop ids are handed out by the public shop list, so anyone
 * on the internet could read the banking details of every shop on the platform.
 *
 * Those fields already had a properly guarded endpoint
 * (`GET /shops/:shopId/bank-details`, admin or owner only). This route was
 * bypassing it, which is the shape of the bug worth remembering: the protection
 * existed and a second door ignored it.
 *
 * These tests assert on the *projection* — the set of fields that come back —
 * because that is the thing that leaked. A test that only checked the balance
 * would have passed while the account number went out beside it.
 */

const mockFindUnique = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: { shop: { findUnique: mockFindUnique } },
}));

import { getShopById } from '../services/shop.service';

const OWNER = 'user_owner';
const OTHER = 'user_other';

/** Fields that must never reach someone who is not the owner or an admin. */
const SECRET_FIELDS = [
  'payoutMethods',
  'pendingBalance',
  'ledgerBalance',
  'debtAmount',
  'owner',
  'ownerUserId',
  'rejectionReason',
];

/**
 * Answer from the shape of the `select`, the way Prisma does. This is what
 * makes the test meaningful: it fails if the service asks for a secret field,
 * not merely if a fixture happens to carry one.
 */
function respondFromSelect(args: { select?: Record<string, unknown> } | undefined) {
  const select = args?.select ?? {};
  const row: Record<string, unknown> = {};

  const values: Record<string, unknown> = {
    id: 'shop_1',
    ownerUserId: OWNER,
    name: 'Campus Print',
    address: 'Block C',
    bwPerPage: 100,
    colorPerPage: 300,
    isOpen: true,
    isApproved: true,
    isArchived: false,
    isVerified: true,
    isRejected: false,
    rejectionReason: 'Blurred licence photo',
    contactPhone: '99999',
    contactPhoneAlt: '88888',
    contactEmail: 'shop@example.com',
    whatsappNumber: '99999',
    pendingBalance: 45000,
    ledgerBalance: 120000,
    debtAmount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    payoutMethods: [
      { id: 'pm_1', type: 'BANK_ACCOUNT', accountNumber: '000123456789', ifscCode: 'HDFC0001' },
    ],
    owner: { id: OWNER, name: 'Ravi', email: 'ravi@example.com' },
  };

  for (const key of Object.keys(select)) {
    if (select[key]) row[key] = values[key];
  }
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUnique.mockImplementation(
    async (args: { select?: Record<string, unknown> }) => respondFromSelect(args)
  );
});

describe('an anonymous caller', () => {
  test('gets what a student needs to choose a shop', async () => {
    const shop = (await getShopById('shop_1')) as Record<string, unknown>;

    expect(shop.name).toBe('Campus Print');
    expect(shop.address).toBe('Block C');
    expect(shop.bwPerPage).toBe(100);
    expect(shop.isOpen).toBe(true);
  });

  test('gets none of the shop’s money or banking details', async () => {
    const shop = (await getShopById('shop_1')) as Record<string, unknown>;

    for (const field of SECRET_FIELDS) {
      expect(shop).not.toHaveProperty(field);
    }
  });

  test('never has a bank account number anywhere in the response', async () => {
    // Belt and braces: the field could be renamed or nested and still leak.
    const shop = await getShopById('shop_1');
    expect(JSON.stringify(shop)).not.toContain('000123456789');
    expect(JSON.stringify(shop)).not.toContain('HDFC0001');
    expect(JSON.stringify(shop)).not.toContain('ravi@example.com');
  });
});

describe('a signed-in stranger', () => {
  test('is treated as the public, not as an owner', async () => {
    const shop = (await getShopById('shop_1', {
      userId: OTHER,
      userType: 'STUDENT',
    })) as Record<string, unknown>;

    for (const field of SECRET_FIELDS) {
      expect(shop).not.toHaveProperty(field);
    }
  });

  test('another shop owner cannot read this shop’s payout methods', async () => {
    // The role alone must not widen the projection — only owning *this* shop.
    const shop = (await getShopById('shop_1', {
      userId: OTHER,
      userType: 'SHOP_OWNER',
    })) as Record<string, unknown>;

    expect(shop).not.toHaveProperty('payoutMethods');
    expect(shop).not.toHaveProperty('ledgerBalance');
  });
});

describe('the owner and admins', () => {
  test('the owner still gets their own balances and payout methods', async () => {
    const shop = (await getShopById('shop_1', {
      userId: OWNER,
      userType: 'SHOP_OWNER',
    })) as Record<string, unknown>;

    expect(shop).toHaveProperty('payoutMethods');
    expect(shop).toHaveProperty('ledgerBalance', 120000);
    expect(shop).toHaveProperty('debtAmount', 0);
    expect(shop).toHaveProperty('owner');
  });

  test('an admin gets the full record for any shop', async () => {
    const shop = (await getShopById('shop_1', {
      userId: 'someone_else_entirely',
      userType: 'ADMIN',
    })) as Record<string, unknown>;

    expect(shop).toHaveProperty('payoutMethods');
    expect(shop).toHaveProperty('pendingBalance');
  });
});

describe('a shop that does not exist', () => {
  test('is a 404 rather than an empty public record', async () => {
    mockFindUnique.mockResolvedValue(null);
    await expect(getShopById('nope')).rejects.toThrow(/not found/i);
  });
});
