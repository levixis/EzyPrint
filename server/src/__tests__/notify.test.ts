/**
 * Unit Tests — who gets told about what.
 *
 * The notification table had no writer at all before this: `createNotification`
 * existed and nothing in the codebase called it, so the bell was permanently
 * empty for students, shops and admins alike, and the only thing users ever saw
 * were session-local toasts that vanished on refresh.
 *
 * Now that events do fan out, the rule that actually needs defending is that
 * nobody is notified about their own action. A shop owner who buzzes their own
 * phone every time they press "Ready for pickup" turns the feature into
 * something people mute, which costs them the one notification that matters —
 * a new paid order with a student waiting at the counter.
 */

const mockNotificationCreate = jest.fn().mockResolvedValue({});
const mockUserFindMany = jest.fn().mockResolvedValue([]);
const mockShopFindUnique = jest.fn().mockResolvedValue(null);
const mockSendPush = jest.fn().mockResolvedValue(undefined);

jest.mock('../utils/prisma', () => ({
  prisma: {
    notification: { create: mockNotificationCreate },
    user: { findMany: mockUserFindMany },
    shop: { findUnique: mockShopFindUnique },
  },
}));

jest.mock('../services/push.service', () => ({
  sendPushToUser: mockSendPush,
}));

import * as notify from '../services/notify.service';

/** The fan-out is deliberately not awaited by callers, so let it drain. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

/** Recipient ids the notification table was written for. */
const recipients = () =>
  mockNotificationCreate.mock.calls.map((call) => call[0].data.recipientUserId);

beforeEach(() => {
  jest.clearAllMocks();
  mockNotificationCreate.mockResolvedValue({});
  mockUserFindMany.mockResolvedValue([]);
  mockShopFindUnique.mockResolvedValue(null);
});

describe('Order status notifications', () => {
  const base = {
    orderId: 'order_1',
    shopId: 'shop_1',
    studentUserId: 'student_1',
    ownerUserId: 'owner_1',
  };

  test('the student hears when the shop moves their order along', async () => {
    notify.notifyOrderStatus({ ...base, newStatus: 'READY_FOR_PICKUP', actorUserId: 'owner_1' });
    await drain();

    expect(recipients()).toEqual(['student_1']);
  });

  test('the shop is not buzzed by its own button press', async () => {
    // The owner is looking at the screen they just tapped.
    notify.notifyOrderStatus({ ...base, newStatus: 'PRINTING', actorUserId: 'owner_1' });
    await drain();

    expect(recipients()).not.toContain('owner_1');
  });

  test('a student cancelling reaches the shop, which is not watching', async () => {
    notify.notifyOrderStatus({ ...base, newStatus: 'CANCELLED', actorUserId: 'student_1' });
    await drain();

    // The student pressed cancel and knows; the shop needs to stop printing.
    expect(recipients()).toEqual(['owner_1']);
  });

  test('PENDING_APPROVAL stays silent', async () => {
    // The student is on the payment confirmation screen watching this happen.
    notify.notifyOrderStatus({ ...base, newStatus: 'PENDING_APPROVAL', actorUserId: 'student_1' });
    await drain();

    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });

  test('a new paid order goes to the shop on the orders channel', async () => {
    notify.notifyNewOrder({
      id: 'order_1',
      shopId: 'shop_1',
      userName: 'Asha',
      ownerUserId: 'owner_1',
    });
    await drain();

    expect(recipients()).toEqual(['owner_1']);
    // This is the one notification that must survive a muted phone.
    expect(mockSendPush).toHaveBeenCalledWith(
      'owner_1',
      expect.objectContaining({ channel: 'ezyprint_orders' })
    );
  });
});

describe('Ticket notifications', () => {
  beforeEach(() => {
    mockUserFindMany.mockResolvedValue([{ id: 'admin_1' }, { id: 'admin_2' }]);
  });

  test('a new ticket reaches every admin but not its author', async () => {
    notify.notifyTicketCreated({
      id: 'ticket_1',
      subject: 'Printer jammed',
      raisedBy: 'student_1',
      raisedByName: 'Asha',
      shopId: null,
    });
    await drain();

    expect(recipients()).toEqual(['admin_1', 'admin_2']);
  });

  test('a ticket filed against a shop also reaches that shop', async () => {
    mockShopFindUnique.mockResolvedValue({ ownerUserId: 'owner_1' });

    notify.notifyTicketCreated({
      id: 'ticket_1',
      subject: 'Wrong pages printed',
      raisedBy: 'student_1',
      raisedByName: 'Asha',
      shopId: 'shop_1',
    });
    await drain();

    // This is what makes tickets a shop-side category, not an admin-only one.
    expect(recipients()).toContain('owner_1');
  });

  test('an admin raising a ticket is not notified of their own ticket', async () => {
    notify.notifyTicketCreated({
      id: 'ticket_1',
      subject: 'Internal note',
      raisedBy: 'admin_1',
      raisedByName: 'Admin',
      shopId: null,
    });
    await drain();

    expect(recipients()).toEqual(['admin_2']);
  });

  test('a reply reaches the rest of the thread and not the sender', async () => {
    mockShopFindUnique.mockResolvedValue({ ownerUserId: 'owner_1' });

    notify.notifyTicketReply({
      ticketId: 'ticket_1',
      subject: 'Wrong pages printed',
      raisedBy: 'student_1',
      shopId: 'shop_1',
      senderId: 'owner_1',
      senderName: 'Shop',
    });
    await drain();

    const told = recipients();
    expect(told).toContain('student_1');
    expect(told).toContain('admin_1');
    expect(told).not.toContain('owner_1');
  });

  test('resolution reaches the raiser and the shop, not the admin who resolved it', async () => {
    mockShopFindUnique.mockResolvedValue({ ownerUserId: 'owner_1' });

    notify.notifyTicketStatus({
      ticketId: 'ticket_1',
      subject: 'Wrong pages printed',
      raisedBy: 'student_1',
      shopId: 'shop_1',
      newStatus: 'RESOLVED',
      actorUserId: 'admin_1',
    });
    await drain();

    expect(recipients().sort()).toEqual(['owner_1', 'student_1']);
  });
});

describe('Failures stay contained', () => {
  test('a failed notification never propagates into the business flow', async () => {
    // The order transition it describes has already committed. Throwing here
    // would surface as a failed status change for work that genuinely happened.
    mockNotificationCreate.mockRejectedValue(new Error('database is down'));

    expect(() =>
      notify.notifyOrderStatus({
        orderId: 'order_1',
        shopId: 'shop_1',
        studentUserId: 'student_1',
        ownerUserId: 'owner_1',
        newStatus: 'COMPLETED',
        actorUserId: 'owner_1',
      })
    ).not.toThrow();

    await drain();
  });

  test('one recipient failing does not silence the others', async () => {
    mockUserFindMany.mockResolvedValue([{ id: 'admin_1' }, { id: 'admin_2' }]);
    mockNotificationCreate
      .mockRejectedValueOnce(new Error('constraint violation'))
      .mockResolvedValue({});

    notify.notifyTicketCreated({
      id: 'ticket_1',
      subject: 'Printer jammed',
      raisedBy: 'student_1',
      raisedByName: 'Asha',
      shopId: null,
    });
    await drain();

    // Both were attempted; the first one's failure did not abort the second.
    expect(mockNotificationCreate).toHaveBeenCalledTimes(2);
  });
});
