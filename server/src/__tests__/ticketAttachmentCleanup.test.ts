/**
 * A ticket is only "cleaned" when its attachments are actually gone.
 *
 * `sweepUndeletedFiles` selects tickets on `attachmentsCleanedAt: null`, so
 * that column is the only thing standing between a failed delete and a retry.
 * It used to be stamped unconditionally, after a loop that catches and logs
 * each failure — so a few seconds of R2 being unreachable marked the ticket
 * clean forever while the bytes stayed in the bucket, permanently invisible to
 * the sweep that exists to catch exactly that.
 *
 * `purgeOrderFiles` gets this right in the same file and says why: the flag is
 * the source of truth, so it must never claim a file is gone while it is not.
 */

const mockAttachmentFindMany = jest.fn();
const mockAttachmentDelete = jest.fn();
const mockTicketUpdateMany = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    ticketAttachment: { findMany: mockAttachmentFindMany, delete: mockAttachmentDelete },
    ticket: { updateMany: mockTicketUpdateMany },
  },
}));

const mockDeleteFile = jest.fn();
jest.mock('../services/storage.service', () => ({ deleteFile: mockDeleteFile }));

import { purgeTicketAttachments } from '../services/cleanup.service';

const twoAttachments = [
  { id: 'att_1', storageKey: 'tickets/a.png' },
  { id: 'att_2', storageKey: 'tickets/b.png' },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockAttachmentFindMany.mockResolvedValue(twoAttachments);
  mockAttachmentDelete.mockResolvedValue({});
  mockTicketUpdateMany.mockResolvedValue({ count: 1 });
  mockDeleteFile.mockResolvedValue(undefined);
});

describe('purgeTicketAttachments', () => {
  test('stamps the ticket clean when every attachment is removed', async () => {
    const removed = await purgeTicketAttachments('ticket_1');

    expect(removed).toBe(2);
    expect(mockTicketUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockTicketUpdateMany.mock.calls[0][0].data.attachmentsCleanedAt).toBeInstanceOf(Date);
  });

  test('a ticket with no attachments is still stamped, so the sweep stops looking', async () => {
    // Nothing to remove is a finished ticket, not a failed one.
    mockAttachmentFindMany.mockResolvedValue([]);

    await purgeTicketAttachments('ticket_1');

    expect(mockTicketUpdateMany).toHaveBeenCalledTimes(1);
  });

  test('one storage failure leaves the ticket unstamped, so the sweep retries it', async () => {
    // The bug: this stamped anyway and the remaining object was never revisited.
    mockDeleteFile.mockRejectedValueOnce(new Error('R2 unreachable'));

    const removed = await purgeTicketAttachments('ticket_1');

    expect(removed).toBe(1);
    expect(mockTicketUpdateMany).not.toHaveBeenCalled();
  });

  test('the attachments that did delete stay deleted', async () => {
    // Not stamping must not mean redoing work — the successful rows are gone
    // and the retry only has the failed one left to try.
    mockDeleteFile.mockRejectedValueOnce(new Error('R2 unreachable'));

    await purgeTicketAttachments('ticket_1');

    expect(mockAttachmentDelete).toHaveBeenCalledTimes(1);
    expect(mockAttachmentDelete.mock.calls[0][0]).toEqual({ where: { id: 'att_2' } });
  });

  test('a row delete failing also holds the stamp back', async () => {
    // The object went but the row did not, so the ticket still has an
    // attachment pointing at a key that is gone. Still not clean.
    mockAttachmentDelete.mockRejectedValueOnce(new Error('deadlock'));

    await purgeTicketAttachments('ticket_1');

    expect(mockTicketUpdateMany).not.toHaveBeenCalled();
  });
});
