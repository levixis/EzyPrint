/**
 * Email as a third notification transport.
 *
 * The bell and the push both assume someone opens the app. That holds for
 * orders — minutes long, actively watched — and fails exactly where the stakes
 * are highest. A shop owner waiting on their application has no reason to open
 * EzyPrint for days, and a payout decision concerns money that has already
 * moved. Those two need to be reached where they already are.
 *
 * So email is opt-in per event, not on by default. The same reasoning inverts
 * for order updates: a student ordering twice a week would get hundreds of
 * emails a term, and an inbox that noisy gets filtered — taking the payout
 * emails with it.
 */

const mockNotificationCreate = jest.fn();
const mockUserFindUnique = jest.fn();
const mockUserFindMany = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    notification: { create: (...a: unknown[]) => mockNotificationCreate(...a) },
    user: {
      findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
      findMany: (...a: unknown[]) => mockUserFindMany(...a),
    },
    order: { findUnique: jest.fn() },
    shop: { findUnique: jest.fn() },
    ticket: { findUnique: jest.fn() },
  },
}));

const mockPush = jest.fn();
jest.mock('../services/push.service', () => ({ sendPushToUser: (...a: unknown[]) => mockPush(...a) }));

const mockSendNotice = jest.fn();
jest.mock('../services/email.service', () => ({
  sendNoticeEmail: (...a: unknown[]) => mockSendNotice(...a),
}));

import { notifyShopDecision, notifyPayoutUpdate, notifyOrderStatus } from '../services/notify.service';

/** The helpers are fire-and-forget, so let the microtask queue drain. */
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  mockNotificationCreate.mockResolvedValue({ id: 'n1' });
  mockUserFindUnique.mockResolvedValue({ email: 'owner@shop.com' });
  mockSendNotice.mockResolvedValue(undefined);
});

const SHOP = { shopId: 'shop_1', ownerUserId: 'owner_1', shopName: 'Campus Copy' };

describe('A shop hears about the decision on its application', () => {
  test('approval writes the in-app row and emails the owner', async () => {
    notifyShopDecision({ ...SHOP, approved: true });
    await settle();

    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
    expect(mockSendNotice).toHaveBeenCalledTimes(1);
    const sent = mockSendNotice.mock.calls[0][0];
    expect(sent.to).toBe('owner@shop.com');
    expect(sent.subject).toMatch(/Campus Copy/);
    expect(sent.tone).toBe('good');
  });

  test('a rejection carries the admin’s reason into the email', async () => {
    // Without it the email generates a support ticket instead of resolving one.
    notifyShopDecision({ ...SHOP, approved: false, reason: 'Address could not be verified.' });
    await settle();

    expect(mockSendNotice.mock.calls[0][0].detail).toBe('Address could not be verified.');
    expect(mockSendNotice.mock.calls[0][0].tone).toBe('bad');
  });

  test('a rejection with no reason still sends, without an empty reason block', async () => {
    notifyShopDecision({ ...SHOP, approved: false, reason: null });
    await settle();

    expect(mockSendNotice).toHaveBeenCalledTimes(1);
    expect(mockSendNotice.mock.calls[0][0].detail).toBeUndefined();
  });
});

describe('Payouts email only when an admin decided', () => {
  test('an admin decision sends an email copy', async () => {
    notifyPayoutUpdate({
      shopId: 'shop_1', ownerUserId: 'owner_1',
      message: '₹600.00 has been sent to your bank account.',
      type: 'success',
      emailSubject: 'Your EzyPrint payout has been sent',
    });
    await settle();

    expect(mockSendNotice).toHaveBeenCalledTimes(1);
    expect(mockSendNotice.mock.calls[0][0].lines[0]).toMatch(/₹600\.00/);
  });

  test('a shop acting on its own payout gets no email', async () => {
    // Requesting, disputing and confirming are the shop's own button presses.
    notifyPayoutUpdate({
      shopId: 'shop_1', ownerUserId: 'owner_1',
      message: 'Your payout request was submitted.',
    });
    await settle();

    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
    expect(mockSendNotice).not.toHaveBeenCalled();
  });

  test('a warning is toned as bad so it does not read like good news', async () => {
    notifyPayoutUpdate({
      shopId: 'shop_1', ownerUserId: 'owner_1',
      message: 'Your payout request was cancelled by an admin.',
      type: 'warning',
      emailSubject: 'Your EzyPrint payout request was cancelled',
    });
    await settle();

    expect(mockSendNotice.mock.calls[0][0].tone).toBe('bad');
  });
});

describe('Everything else stays out of the inbox', () => {
  test('an order status change notifies in-app and push, never email', async () => {
    // The volume argument: this fires several times per order, per student.
    mockUserFindUnique.mockResolvedValue({ email: 'student@campus.edu' });
    notifyOrderStatus({
      orderId: 'ord_1', studentUserId: 'student_1', shopId: 'shop_1',
      ownerUserId: 'owner_1', newStatus: 'READY_FOR_PICKUP' as never,
      actorUserId: 'owner_1',
    });
    await settle();

    expect(mockNotificationCreate).toHaveBeenCalled();
    expect(mockSendNotice).not.toHaveBeenCalled();
  });
});

describe('Email never breaks the thing it is announcing', () => {
  test('a send failure leaves the in-app row written', async () => {
    mockSendNotice.mockRejectedValue(new Error('Resend 503'));

    notifyShopDecision({ ...SHOP, approved: true });
    await settle();

    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
  });

  test('an account with no email address is skipped, not failed', async () => {
    // User.email is nullable; an account without one is not an error.
    mockUserFindUnique.mockResolvedValue({ email: null });

    notifyShopDecision({ ...SHOP, approved: true });
    await settle();

    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
    expect(mockSendNotice).not.toHaveBeenCalled();
  });
});
