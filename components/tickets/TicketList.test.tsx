import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TicketList from './TicketList';
import { SupportTicket, TicketStatus, TicketCategory, UserType } from '../../types';

/**
 * The regression test for the blank page.
 *
 * TicketList read `ticket.messages.length`, but the list endpoint sent a
 * message count and no thread. With no tickets the component returned early,
 * so the bug stayed invisible until a user created their first one — at which
 * point the map threw, React unmounted the whole tree, and the entire app went
 * white. Not a broken panel: nothing rendered at all.
 *
 * These render the component against the payload shapes the server actually
 * produces, including the one that crashed it.
 */

/** A ticket exactly as the list endpoint used to return it: no `messages`. */
const listShapedTicket = {
  id: 'tkt_1',
  raisedBy: 'usr_1',
  raisedByType: UserType.STUDENT,
  raisedByName: 'Aastha Kumari',
  subject: 'Why have I not received my pass',
  category: TicketCategory.PAYMENT_ISSUE,
  description: 'paid for the pass but didnt got one',
  status: TicketStatus.OPEN,
  createdAt: new Date('2026-08-01').toISOString(),
  messageCount: 1,
} as unknown as SupportTicket;

describe('TicketList', () => {
  test('renders a ticket that arrives without a messages array', () => {
    // This is the exact input that used to throw and blank the app.
    expect(() => render(<TicketList tickets={[listShapedTicket]} />)).not.toThrow();
    expect(screen.getByText('Why have I not received my pass')).toBeDefined();
  });

  test('shows the message count from the field the list endpoint sends', () => {
    render(<TicketList tickets={[listShapedTicket]} />);
    expect(screen.getByText('1 msgs')).toBeDefined();
  });

  test('falls back to counting the thread when only messages are present', () => {
    const withThread = {
      ...listShapedTicket,
      messageCount: undefined,
      messages: [
        { id: 'm1', senderId: 'usr_1', senderName: 'Aastha', senderType: UserType.STUDENT, message: 'first' },
        { id: 'm2', senderId: 'adm_1', senderName: 'Support', senderType: UserType.ADMIN, message: 'second' },
      ],
    } as unknown as SupportTicket;

    render(<TicketList tickets={[withThread]} />);
    expect(screen.getByText('2 msgs')).toBeDefined();
  });

  test('previews the latest message when the thread is present', () => {
    const withThread = {
      ...listShapedTicket,
      messages: [
        { id: 'm1', senderId: 'usr_1', senderName: 'Aastha', senderType: UserType.STUDENT, message: 'first' },
        { id: 'm2', senderId: 'adm_1', senderName: 'Support', senderType: UserType.ADMIN, message: 'looking into it' },
      ],
    } as unknown as SupportTicket;

    render(<TicketList tickets={[withThread]} />);
    expect(screen.getByText(/Support/)).toBeDefined();
    expect(screen.getByText(/looking into it/)).toBeDefined();
  });

  test('an empty list renders its own state rather than crashing', () => {
    expect(() => render(<TicketList tickets={[]} />)).not.toThrow();
  });

  test('survives a ticket whose messages field is malformed', () => {
    // Defence in depth: the schema layer coerces this to [], but the component
    // must not depend on that having run.
    const malformed = { ...listShapedTicket, messages: null } as unknown as SupportTicket;
    expect(() => render(<TicketList tickets={[malformed]} />)).not.toThrow();
  });
});
