import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  supportTicketSchema,
  orderSchema,
  payoutSchema,
  parseResponse,
  parseListResponse,
} from './schemas';

/**
 * These pin the behaviour that a whole class of outage depended on.
 *
 * The list endpoint sent a message *count* while the type declared a message
 * *array*. TypeScript accepted it because the response was asserted into the
 * type rather than checked against it, so `messages.length` threw on the first
 * ticket a user ever had and unmounted the entire React tree — a blank page,
 * not a broken panel.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Ticket responses', () => {
  test('the exact payload that blanked the app now parses to something renderable', () => {
    // Verbatim shape the server was sending: _count, no `messages`.
    const fromServer = {
      id: 'tkt_1',
      subject: 'Why have I not received my pass',
      status: 'OPEN',
      category: 'PAYMENT_ISSUE',
      raisedBy: 'usr_1',
      raisedByName: 'Aastha',
      _count: { messages: 1 },
    };

    const ticket = supportTicketSchema.parse(fromServer);

    expect(ticket.messages).toEqual([]);
    // The line that used to throw.
    expect(() => ticket.messages.length).not.toThrow();
    expect(ticket.messages.length).toBe(0);
  });

  test('a malformed collection degrades to empty rather than to undefined', () => {
    const ticket = supportTicketSchema.parse({
      id: 'tkt_2',
      status: 'OPEN',
      category: 'OTHER',
      raisedBy: 'usr_1',
      messages: 'not-an-array',
      attachments: null,
      attachmentPaths: 42,
    });

    expect(ticket.messages).toEqual([]);
    expect(ticket.attachments).toEqual([]);
    expect(ticket.attachmentPaths).toEqual([]);
  });

  test('unknown server fields survive instead of failing the parse', () => {
    // A backend adding a column must never be a frontend outage.
    const ticket = supportTicketSchema.parse({
      id: 'tkt_3',
      status: 'OPEN',
      category: 'OTHER',
      raisedBy: 'usr_1',
      somethingAddedLater: { nested: true },
    }) as Record<string, unknown>;

    expect(ticket.somethingAddedLater).toEqual({ nested: true });
  });

  test('a real thread is preserved intact', () => {
    const ticket = supportTicketSchema.parse({
      id: 'tkt_4',
      status: 'OPEN',
      category: 'OTHER',
      raisedBy: 'usr_1',
      messages: [
        { id: 'm1', senderId: 'usr_1', senderName: 'Aastha', senderType: 'STUDENT', message: 'hello' },
      ],
      messageCount: 1,
    });

    expect(ticket.messages).toHaveLength(1);
    expect(ticket.messages[0].senderName).toBe('Aastha');
    expect(ticket.messageCount).toBe(1);
  });
});

describe('parseResponse', () => {
  test('never throws, because a validation failure must not become a white screen', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => parseResponse(orderSchema, { totally: 'wrong' }, 'test')).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });

  test('reports the offending field path so drift is diagnosable', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    parseResponse(orderSchema, { id: 'ord_1', shopId: 'shp_1' }, 'orderApi.list');

    const [message, issues] = spy.mock.calls[0];
    expect(message).toContain('orderApi.list');
    expect(JSON.stringify(issues)).toContain('status');
  });

  test('a non-array where a list was expected yields an empty list, not a crash', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(parseListResponse(payoutSchema, { not: 'a list' }, 'payoutApi.list')).toEqual([]);
    expect(spy).not.toThrow;
  });
});

describe('Money fields', () => {
  test('a missing amount becomes 0 rather than undefined arithmetic', () => {
    // `undefined + 100` is NaN, which renders as "₹NaN" on a shop's dashboard.
    const payout = payoutSchema.parse({ id: 'po_1', shopId: 'shp_1', status: 'PENDING' });
    expect(payout.amount).toBe(0);
  });

  test('a real amount passes through untouched', () => {
    const payout = payoutSchema.parse({ id: 'po_2', shopId: 'shp_1', status: 'PAID', amount: 4900 });
    expect(payout.amount).toBe(4900);
  });
});
