import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SupportTicket, TicketStatus, TicketCategory, UserType } from '../../types';

/**
 * TicketDetail renders straight from list data, so every collection it touches
 * must survive being absent.
 *
 * TicketList was fixed and tested for exactly this, and TicketDetail was not —
 * so opening a ticket blanked the page a second time, on `statusHistory`
 * instead of `messages`. Guarding one collection at a time only moves the
 * crash; these cover every array the component reads.
 */

vi.mock('../../contexts/AppContext', () => ({
  useAppContext: () => ({
    tickets: [],
    currentUser: { id: 'usr_1', type: UserType.STUDENT, name: 'Aastha' },
    addTicketMessage: vi.fn(),
    updateTicketStatus: vi.fn(),
    refundRequests: [],
  }),
}));

vi.mock('../../lib/queries', () => ({
  uploadApi: { getDownloadUrl: vi.fn().mockResolvedValue({ url: '' }) },
  adminApi: {},
}));

let TicketDetail: React.ComponentType<{ ticket: SupportTicket; isOpen: boolean; onClose: () => void }>;

beforeEach(async () => {
  TicketDetail = (await import('./TicketDetail')).default;
});

/** The minimum a ticket carries — every collection missing. */
const bareTicket = {
  id: 'tkt_1',
  raisedBy: 'usr_1',
  raisedByType: UserType.STUDENT,
  raisedByName: 'Aastha Kumari',
  subject: 'Why have I not received my pass',
  category: TicketCategory.PAYMENT_ISSUE,
  description: 'paid for the pass but didnt got one',
  status: TicketStatus.OPEN,
  createdAt: new Date('2026-08-01').toISOString(),
} as unknown as SupportTicket;

const renderDetail = (ticket: SupportTicket) =>
  render(<TicketDetail ticket={ticket} isOpen onClose={() => {}} />);

describe('TicketDetail', () => {
  test('opens a ticket that has no statusHistory', () => {
    // The crash that blanked the page the second time.
    expect(() => renderDetail(bareTicket)).not.toThrow();
  });

  test('opens a ticket that has no messages', () => {
    expect(() => renderDetail({ ...bareTicket, statusHistory: [] } as SupportTicket)).not.toThrow();
  });

  test('opens a ticket with no attachments of either shape', () => {
    // attachmentPaths is the legacy field, attachments the current one; a
    // ticket can arrive with neither.
    expect(() => renderDetail({ ...bareTicket, messages: [], statusHistory: [] } as SupportTicket)).not.toThrow();
  });

  test('survives every collection being explicitly null', () => {
    const hostile = {
      ...bareTicket,
      messages: null,
      statusHistory: null,
      attachments: null,
      attachmentPaths: null,
    } as unknown as SupportTicket;

    expect(() => renderDetail(hostile)).not.toThrow();
  });

  test('renders the subject once open', () => {
    renderDetail(bareTicket);
    expect(screen.getAllByText(/Why have I not received my pass/).length).toBeGreaterThan(0);
  });

  test('renders a full ticket with every collection populated', () => {
    const full = {
      ...bareTicket,
      messages: [
        { id: 'm1', senderId: 'usr_1', senderName: 'Aastha', senderType: UserType.STUDENT, message: 'hello', createdAt: new Date().toISOString() },
      ],
      statusHistory: [
        { id: 's1', from: 'OPEN', to: 'OPEN', changedByName: 'Aastha', note: 'Ticket created', createdAt: new Date().toISOString() },
        { id: 's2', from: 'OPEN', to: 'IN_REVIEW', changedByName: 'Support', note: null, createdAt: new Date().toISOString() },
      ],
      attachments: [],
      attachmentPaths: [],
    } as unknown as SupportTicket;

    expect(() => renderDetail(full)).not.toThrow();
    expect(screen.getAllByText(/hello/).length).toBeGreaterThan(0);
  });
});
