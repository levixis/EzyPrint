import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

export const addTicketMessageMock = vi.fn().mockResolvedValue({ success: true });

vi.mock('../../contexts/AppContext', () => ({
  useAppContext: () => ({
    tickets: [],
    currentUser: { id: 'usr_1', type: UserType.STUDENT, name: 'Aastha' },
    addTicketMessage: addTicketMessageMock,
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

/**
 * Attaching files to a reply.
 *
 * The composer was text-only, so a student mid-conversation could not send the
 * screenshot the whole conversation was about — attachments existed only at
 * ticket creation.
 */
describe('Reply attachments', () => {
  const file = (name: string, bytes: number) =>
    new File(['x'.repeat(bytes)], name, { type: 'image/jpeg' });

  // The modal renders through a portal, so queries must go via screen/document
  // rather than the container render() returns.
  const openComposer = () => {
    addTicketMessageMock.mockClear();
    renderDetail({ ...bareTicket, messages: [], statusHistory: [] } as SupportTicket);
    const input = screen.getByLabelText('Attach files') as HTMLInputElement;
    return { input };
  };

  const clickSend = () => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return userEvent.click(buttons[buttons.length - 1]);
  };

  test('the composer offers a file input', () => {
    const { input } = openComposer();
    expect(input).not.toBeNull();
  });

  test('a chosen file appears before it is sent', async () => {
    const { input } = openComposer();
    await userEvent.upload(input, file('screenshot.jpeg', 100));
    expect(screen.getByText('screenshot.jpeg')).toBeDefined();
  });

  test('a file over 5MB is refused with a reason rather than silently dropped', async () => {
    const { input } = openComposer();
    await userEvent.upload(input, file('huge.jpeg', 6 * 1024 * 1024));
    expect(screen.getByText(/over 5MB/)).toBeDefined();
    expect(screen.queryByText('huge.jpeg')).toBeNull();
  });

  test('a chosen file can be removed again', async () => {
    const { input } = openComposer();
    await userEvent.upload(input, file('oops.jpeg', 100));
    await userEvent.click(screen.getByLabelText('Remove oops.jpeg'));
    expect(screen.queryByText('oops.jpeg')).toBeNull();
  });

  test('files reach the send handler with the id minted at pick time', async () => {
    const { input } = openComposer();
    await userEvent.upload(input, file('proof.jpeg', 100));
    await clickSend();

    const calls = addTicketMessageMock.mock.calls;
    const [, , attachments] = calls[calls.length - 1] ?? [];
    expect(attachments).toHaveLength(1);
    // Stable across retries, so the server dedupes rather than storing twice.
    expect(attachments[0].uploadId).toMatch(/^tkt_/);
    expect(attachments[0].file.name).toBe('proof.jpeg');
  });

  test('an attachment with no text still sends, described rather than rejected', async () => {
    const { input } = openComposer();
    await userEvent.upload(input, file('only-a-file.jpeg', 100));
    await clickSend();

    const calls = addTicketMessageMock.mock.calls;
    const [, message] = calls[calls.length - 1] ?? [];
    expect(message).toBe('Attached 1 file');
  });
});

/**
 * Previewing an attachment in place.
 *
 * Opening a screenshot in a new tab loses the conversation it was sent to
 * illustrate, which for a support thread is most of its value.
 */
describe('Attachment preview', () => {
  const withAttachment = (fileName: string) => ({
    ...bareTicket,
    statusHistory: [],
    messages: [
      { id: 'm1', senderId: 'usr_2', senderName: 'Support', senderType: UserType.ADMIN, message: 'see this', createdAt: new Date().toISOString() },
    ],
    attachments: [
      { id: 'a1', storageKey: 'tickets/x/' + fileName, originalName: fileName, messageId: 'm1' },
    ],
  } as unknown as SupportTicket);

  test('an image offers a preview rather than a bare link', async () => {
    renderDetail(withAttachment('screenshot.png'));
    expect(await screen.findByText('Preview')).toBeDefined();
  });

  test('a format the browser cannot render still opens externally', async () => {
    renderDetail(withAttachment('notes.docx'));
    expect(await screen.findByText('Open')).toBeDefined();
    expect(screen.queryByText('Preview')).toBeNull();
  });

  test('clicking an image opens it over the conversation, not in a new tab', async () => {
    renderDetail(withAttachment('screenshot.png'));
    await userEvent.click(await screen.findByText('Preview'));

    // The conversation is still mounted behind the overlay.
    expect(screen.getByRole('dialog', { name: /Preview of screenshot.png/ })).toBeDefined();
    expect(screen.getAllByText(/see this/).length).toBeGreaterThan(0);
  });

  test('the preview can be dismissed without closing the ticket', async () => {
    renderDetail(withAttachment('screenshot.png'));
    await userEvent.click(await screen.findByText('Preview'));
    await userEvent.click(screen.getByLabelText('Close preview'));

    expect(screen.queryByRole('dialog', { name: /Preview of/ })).toBeNull();
    expect(screen.getAllByText(/see this/).length).toBeGreaterThan(0);
  });

  test('the original is still reachable from inside the preview', async () => {
    renderDetail(withAttachment('screenshot.png'));
    await userEvent.click(await screen.findByText('Preview'));

    const original = screen.getByText('Open original') as HTMLAnchorElement;
    expect(original.getAttribute('target')).toBe('_blank');
  });
});
