/**
 * Who may move a ticket's status.
 *
 * The route was ADMIN-only, so two buttons that shipped could never work: a
 * shop closing a complaint it had just settled by refunding, and a student
 * escalating their own ticket. Both returned 403.
 *
 * Opening it is not the same as letting anyone set anything. A shop is a party
 * to a complaint against it, so it may say "dealt with" but not file the thing
 * away; that call belongs to the student or an admin.
 */

const mockFindUnique = jest.fn();
const mockUserFindUnique = jest.fn();
const mockShopFindUnique = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    ticket: { findUnique: (...a: unknown[]) => mockFindUnique(...a), update: jest.fn() },
    user: { findUnique: (...a: unknown[]) => mockUserFindUnique(...a) },
    shop: { findUnique: (...a: unknown[]) => mockShopFindUnique(...a) },
    ticketStatusChange: { create: jest.fn() },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));
jest.mock('../services/notify.service', () => ({
  notifyTicketStatus: jest.fn(), notifyTicketCreated: jest.fn(), notifyTicketReply: jest.fn(),
}));
// Returns a promise: the service chains .catch() on it, and a bare jest.fn()
// hands back undefined.
jest.mock('../services/cleanup.service', () => ({
  purgeTicketAttachments: jest.fn().mockResolvedValue(0),
}));

import { updateTicketStatus } from '../services/ticket.service';

const TICKET = { id: 'tkt_1', raisedBy: 'student_1', shopId: 'shop_1', status: 'OPEN' };

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUnique.mockResolvedValue(TICKET);
  mockUserFindUnique.mockResolvedValue({ name: 'Someone' });
  mockShopFindUnique.mockResolvedValue({ id: 'shop_1' });
  mockTransaction.mockResolvedValue([{ ...TICKET }]);
});

const set = (status: string, userId: string, userType: string) =>
  updateTicketStatus('tkt_1', status as never, userId, undefined, userType);

describe('The shop the complaint is about', () => {
  test('can mark it resolved', async () => {
    await expect(set('RESOLVED', 'owner_1', 'SHOP_OWNER')).resolves.toBeDefined();
  });

  test('can acknowledge it', async () => {
    await expect(set('IN_REVIEW', 'owner_1', 'SHOP_OWNER')).resolves.toBeDefined();
  });

  test('cannot close it', async () => {
    // A party to a dispute must not be able to file it away. RESOLVED says
    // "we dealt with this"; whether that is true is not theirs to decide.
    await expect(set('CLOSED', 'owner_1', 'SHOP_OWNER')).rejects.toThrow(/only the student or an admin can close/);
  });

  test('cannot reopen it either', async () => {
    await expect(set('OPEN', 'owner_1', 'SHOP_OWNER')).rejects.toThrow(/cannot set/i);
  });
});

describe('The student who raised it', () => {
  test('can escalate', async () => {
    await expect(set('IN_REVIEW', 'student_1', 'STUDENT')).resolves.toBeDefined();
  });

  test('can close their own complaint', async () => {
    await expect(set('CLOSED', 'student_1', 'STUDENT')).resolves.toBeDefined();
  });

  test('cannot mark it resolved', async () => {
    // RESOLVED is the shop's or admin's assertion that the work was done.
    await expect(set('RESOLVED', 'student_1', 'STUDENT')).rejects.toThrow(/cannot set/i);
  });
});

describe('Someone unrelated', () => {
  test('cannot touch it at all', async () => {
    mockShopFindUnique.mockResolvedValue({ id: 'shop_other' });
    await expect(set('CLOSED', 'owner_other', 'SHOP_OWNER')).rejects.toThrow(/do not have access/);
  });

  test('a different student cannot close it', async () => {
    await expect(set('CLOSED', 'student_2', 'STUDENT')).rejects.toThrow(/do not have access/);
  });
});

describe('Admin', () => {
  test('can set any status', async () => {
    for (const s of ['OPEN', 'IN_REVIEW', 'RESOLVED', 'CLOSED']) {
      await expect(set(s, 'admin_1', 'ADMIN')).resolves.toBeDefined();
    }
  });
});

describe('A shop owner who raised the ticket themselves', () => {
  test('is treated as the raiser, not the subject', async () => {
    // Their ticket to the admin is their own complaint; being a shop owner
    // elsewhere should not stop them closing it.
    mockFindUnique.mockResolvedValue({ ...TICKET, raisedBy: 'owner_1', shopId: null });
    await expect(set('CLOSED', 'owner_1', 'SHOP_OWNER')).resolves.toBeDefined();
  });
});
