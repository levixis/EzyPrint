import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  supportTicketSchema,
  orderSchema,
  payoutSchema,
  ledgerEntrySchema,
  notificationSchema,
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

/**
 * The ledger feeds the one screen a shop owner checks to see whether they have
 * been paid. It was an unchecked `as` — the schema existed and was applied to
 * nothing — while the dashboard sorted, filtered and reduced over it.
 */
describe('Ledger responses', () => {
  test('a missing entries collection becomes an empty list, not a crash', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // `[...undefined]` throws, and the throw unmounts the tree — a blank money
    // page, which reads to a shop owner exactly like having no money.
    expect(parseListResponse(ledgerEntrySchema, undefined, 'payoutApi.getLedger')).toEqual([]);
    expect(spy).toHaveBeenCalled();
  });

  test('a recoverable row is repaired rather than dropped', () => {
    const parsed = parseListResponse(
      ledgerEntrySchema,
      [
        { id: 'le_1', type: 'ORDER_EARNING', status: 'SETTLED', amount: 300 },
        { id: 'le_2', type: 'REFUND_DEDUCTION', status: 'PENDING' }, // no amount
      ],
      'payoutApi.getLedger'
    );

    expect(parsed).toHaveLength(2);
    expect(parsed[1].amount).toBe(0);
  });

  /**
   * The bug this replaced. Zod validates an array as a unit, so one unusable
   * row failed the whole parse and `.catch([])` then replaced every row with
   * none — a shop's entire ledger emptied by a single bad entry, silently.
   */
  test('one unusable row does not discard its neighbours', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const parsed = parseListResponse(
      ledgerEntrySchema,
      [
        { id: 'le_1', type: 'ORDER_EARNING', status: 'SETTLED', amount: 300 },
        { type: 'ORDER_EARNING', status: 'SETTLED', amount: 700 }, // no id at all
        { id: 'le_3', type: 'PAYOUT', status: 'SETTLED', amount: 500 },
      ],
      'payoutApi.getLedger'
    );

    expect(parsed.map((e) => e.id)).toEqual(['le_1', 'le_3']);
    // And it says so, rather than leaving an unexplained gap.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('reports which row failed and why', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    parseListResponse(ledgerEntrySchema, [{ amount: 1 }], 'payoutApi.getLedger');

    const [message, detail] = spy.mock.calls[0];
    expect(String(message)).toContain('dropped 1 of 1');
    expect(JSON.stringify(detail)).toContain('[0]');
    spy.mockRestore();
  });

  test('an amount that arrives as a string does not become NaN arithmetic', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const entry = ledgerEntrySchema.parse({
      id: 'le_3', type: 'ORDER_EARNING', status: 'SETTLED', amount: '300',
    });

    // Reduced over to produce "Today's Earnings"; a string would concatenate.
    expect(entry.amount).toBe(0);
    expect(typeof entry.amount).toBe('number');
    spy.mockRestore();
  });
});

/**
 * The bell's list is spread alongside the local toasts and then sorted, so an
 * absent collection would take out the header on every screen.
 */
describe('Notification responses', () => {
  test('a missing collection becomes empty rather than unspreadable', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const parsed = parseListResponse(notificationSchema, undefined, 'notificationApi.list');

    expect(() => [...parsed]).not.toThrow();
    expect(parsed).toEqual([]);
    spy.mockRestore();
  });

  test('a notification with no timestamp still sorts deterministically', () => {
    // The merge sorts on `new Date(timestamp)`. Undefined gives NaN, and NaN
    // comparisons are all false, which scrambles the order silently rather
    // than failing — the worst kind of wrong.
    const parsed = notificationSchema.parse({ id: 'n_1', message: 'Order ready' });

    expect(Number.isNaN(new Date(parsed.timestamp).getTime())).toBe(false);
  });

  test('a real notification passes through intact', () => {
    const parsed = notificationSchema.parse({
      id: 'n_2',
      message: 'Your order is printing',
      timestamp: '2026-08-02T04:21:00.000Z',
      read: true,
      targetShopId: 'shop_1',
    });

    expect(parsed.read).toBe(true);
    expect(parsed.targetShopId).toBe('shop_1');
    expect(parsed.timestamp).toBe('2026-08-02T04:21:00.000Z');
  });
});
