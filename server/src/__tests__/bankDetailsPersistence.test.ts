/**
 * The bank name a shop types is the bank name that gets stored.
 *
 * `saveBankDetails` used to hardcode `bankName: 'Unknown'` on create and omit
 * the column entirely on update, while `saveBankDetailsSchema` rejected any
 * request that left it out ("Bank name is required") and `ShopSettingsModal`
 * rendered it straight back to the owner. So the app demanded the field, threw
 * it away, and displayed a placeholder for ever — with no path to correcting it
 * short of editing the row by hand.
 *
 * Pinned here because the round trip is what makes it a bug: reading the
 * controller alone, `'Unknown'` looks like a deliberate default.
 */

const mockShopFindUnique = jest.fn();
const mockBankUpsert = jest.fn();
const mockAccessLogCreate = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    shop: { findUnique: mockShopFindUnique },
    bankDetails: { upsert: mockBankUpsert },
    bankAccessLog: { create: mockAccessLogCreate },
  },
}));

import type { NextFunction, Request, Response } from 'express';
import { saveBankDetails } from '../controllers/shop.controller';

const OWNER = 'owner_1';

const BODY = {
  accountHolderName: 'A Student Print Shop',
  bankName: 'State Bank of India',
  accountNumber: '30123456789',
  ifscCode: 'SBIN0001234',
  accountType: 'CURRENT',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockShopFindUnique.mockResolvedValue({ id: 'shop_1', ownerUserId: OWNER });
  mockBankUpsert.mockResolvedValue({ id: 'bank_1' });
  mockAccessLogCreate.mockResolvedValue({});
});

async function save(body: Record<string, unknown>) {
  const req = {
    params: { shopId: 'shop_1' },
    user: { userId: OWNER, userType: 'SHOP_OWNER' },
    body,
    ip: '10.0.0.1',
  } as unknown as Request;

  const res = { json: jest.fn() } as unknown as Response;
  const next = jest.fn() as NextFunction;

  await saveBankDetails(req, res, next);
  return { res, next };
}

describe('saveBankDetails stores the submitted bank name', () => {
  test('on create', async () => {
    const { next } = await save(BODY);
    expect(next).not.toHaveBeenCalled();

    const { create } = mockBankUpsert.mock.calls[0][0];
    expect(create.bankName).toBe('State Bank of India');
    expect(create.bankName).not.toBe('Unknown');
  });

  test('on update', async () => {
    // The update path omitted the column altogether, so a shop that had once
    // been created with 'Unknown' could never be corrected through the form —
    // resubmitting the settings changed every other field and left this one.
    await save(BODY);

    const { update } = mockBankUpsert.mock.calls[0][0];
    expect(update.bankName).toBe('State Bank of India');
  });

  test('a changed bank name overwrites the stored one', async () => {
    await save({ ...BODY, bankName: 'HDFC Bank' });

    const { create, update } = mockBankUpsert.mock.calls[0][0];
    expect(create.bankName).toBe('HDFC Bank');
    expect(update.bankName).toBe('HDFC Bank');
  });

  test('a missing bank name is rejected rather than defaulted', async () => {
    // The schema already rejects this upstream. Asserted at the controller too
    // because the old default is exactly what a second entry path would
    // reintroduce, and this is the write site.
    const { bankName: _bankName, ...withoutBankName } = BODY;
    const { next } = await save(withoutBankName);

    expect(mockBankUpsert).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
