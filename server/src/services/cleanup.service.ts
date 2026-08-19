import { prisma } from '../utils/prisma';
import * as storageService from './storage.service';
import type { OrderStatus, RefundRequestStatus } from '@prisma/client';

/**
 * File retention — documents are deleted the moment they are no longer needed.
 *
 * A print job is transient: once the order is finished the shop has printed it
 * and nobody needs the bytes again. Keeping them means holding scanned IDs,
 * notarised papers and coursework indefinitely for no operational benefit. A
 * student who wants the same document printed again uploads it again, which
 * costs them one tap and removes an entire category of liability.
 *
 * Deletion runs after the status change commits rather than inside it: removing
 * an object from R2 is a network call, and it must not be able to roll back an
 * order that has already been completed. If it fails the row still says the
 * file is present, so the sweep picks it up later — the flag is the source of
 * truth, not the success of any single delete.
 */

/**
 * Statuses after which an order's files serve no purpose.
 *
 * PAYMENT_FAILED is deliberately absent: that order can still be retried, and
 * deleting its files would leave the student unable to pay for work they
 * already uploaded.
 */
const TERMINAL_ORDER_STATUSES: OrderStatus[] = ['COMPLETED', 'CANCELLED', 'REFUNDED'];

export function isTerminalForFiles(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

/**
 * Refund states that are still being argued about.
 *
 * REFUND_FAILED counts as open: Razorpay rejected the transfer and an admin has
 * to retry, so the claim is live even though the request looks finished.
 */
export const UNSETTLED_REFUND_STATUSES: RefundRequestStatus[] = [
  'PENDING_SHOP',
  'APPROVED_BY_SHOP',
  'REJECTED_BY_SHOP',
  'ESCALATED_TO_ADMIN',
  'AUTO_ESCALATED',
  'PROCESSING_REFUND',
  'REFUND_FAILED',
];

/**
 * Whether someone is still disputing this order.
 *
 * Deleting on completion is right for the ordinary case — the shop printed it
 * and nobody needs the bytes again. It is wrong when a student is claiming the
 * wrong thing was printed, because the file is the only evidence of what was
 * actually sent, and destroying it turns the dispute into one person's word
 * against another's.
 *
 * So the delete is deferred rather than scheduled: files go immediately unless
 * a claim is open, and the sweep removes them once it closes. No blanket
 * retention window, and no order keeps its documents for longer than the
 * argument about it lasts.
 */
async function hasOpenDispute(orderId: string): Promise<boolean> {
  const [refund, ticket] = await Promise.all([
    prisma.refundRequest.findFirst({
      where: { orderId, status: { in: UNSETTLED_REFUND_STATUSES } },
      select: { id: true },
    }),
    prisma.ticket.findFirst({
      where: { relatedOrderId: orderId, status: { in: ['OPEN', 'IN_REVIEW'] } },
      select: { id: true },
    }),
  ]);

  return Boolean(refund || ticket);
}

/**
 * Remove the stored documents for one order.
 *
 * The order row, its prices and its ledger entries all survive — those are
 * needed for reconciliation. Only the document bytes go.
 *
 * Each file is flagged individually right after its object is removed, so a
 * crash midway leaves every already-deleted file marked and the remainder for
 * the next pass. R2's DeleteObject succeeds on a key that is already gone, so
 * a retry is harmless.
 */
export async function purgeOrderFiles(orderId: string): Promise<number> {
  if (await hasOpenDispute(orderId)) return 0;

  const files = await prisma.orderFile.findMany({
    where: { orderId, isFileDeleted: false, fileStoragePath: { not: null } },
    select: { id: true, fileStoragePath: true },
  });

  let removed = 0;

  for (const file of files) {
    try {
      await storageService.deleteFile(file.fileStoragePath as string);
      await prisma.orderFile.update({
        where: { id: file.id },
        data: { isFileDeleted: true, fileStoragePath: null },
      });
      removed++;
    } catch (error) {
      // Left unflagged on purpose: the sweep will try again rather than the
      // file being recorded as deleted while still sitting in the bucket.
      console.error(`[cleanup] could not delete ${file.fileStoragePath} for order ${orderId}:`, error);
    }
  }

  // The order carries a denormalised copy of the first file's path.
  if (removed > 0) {
    await prisma.order.updateMany({
      where: { id: orderId },
      data: { isFileDeleted: true, fileStoragePath: null },
    });
  }

  return removed;
}

/**
 * Remove the attachments on a resolved ticket.
 *
 * The conversation itself is kept — it is the record of what was decided. The
 * files attached to it were evidence for a dispute that is now closed.
 */
export async function purgeTicketAttachments(ticketId: string): Promise<number> {
  const attachments = await prisma.ticketAttachment.findMany({
    where: { ticketId },
    select: { id: true, storageKey: true },
  });

  let removed = 0;
  let failed = 0;

  for (const attachment of attachments) {
    try {
      await storageService.deleteFile(attachment.storageKey);
      await prisma.ticketAttachment.delete({ where: { id: attachment.id } });
      removed++;
    } catch (error) {
      failed++;
      console.error(`[cleanup] could not delete ${attachment.storageKey} for ticket ${ticketId}:`, error);
    }
  }

  // Stamped only when there is genuinely nothing left, which includes the case
  // where there was nothing to remove in the first place — that ticket is done
  // and the sweep should stop reconsidering it.
  //
  // It used to be stamped unconditionally, and `sweepUndeletedFiles` selects on
  // `attachmentsCleanedAt: null`. So a single failed delete — a few seconds of
  // R2 being unreachable is enough — marked the ticket clean forever while its
  // attachments stayed in the bucket. `purgeOrderFiles` gets this right twenty
  // lines above, and says why: the flag is the source of truth, so it must not
  // claim a file is gone while the bytes are still there.
  if (failed === 0) {
    await prisma.ticket.updateMany({
      where: { id: ticketId },
      data: { attachmentsCleanedAt: new Date(), attachmentPaths: [] },
    });
  }

  return removed;
}

export interface SweepResult {
  ordersPurged: number;
  ticketsPurged: number;
  filesRemoved: number;
}

/**
 * Catch anything the inline deletion missed.
 *
 * Inline deletion fails whenever R2 is briefly unreachable, and orders that
 * completed before retention existed at all have files with nothing to trigger
 * their removal. Without this the bucket keeps documents that every other part
 * of the system considers gone.
 */
export async function sweepUndeletedFiles(batchSize = 50): Promise<SweepResult> {
  // Orders under an open complaint are excluded in the query rather than
  // skipped after selection. Skipping would let a handful of long-running
  // disputes occupy every slot in the batch and stall cleanup for everything
  // else. `relatedOrderId` is a plain column rather than a relation, so open
  // tickets are gathered first and excluded by id.
  const disputedByTicket = await prisma.ticket.findMany({
    where: { status: { in: ['OPEN', 'IN_REVIEW'] }, relatedOrderId: { not: null } },
    select: { relatedOrderId: true },
  });
  const disputedOrderIds = disputedByTicket
    .map((t) => t.relatedOrderId)
    .filter((id): id is string => Boolean(id));

  const orders = await prisma.order.findMany({
    where: {
      status: { in: TERMINAL_ORDER_STATUSES },
      files: { some: { isFileDeleted: false, fileStoragePath: { not: null } } },
      id: { notIn: disputedOrderIds },
      OR: [
        { refundRequest: null },
        { refundRequest: { status: { notIn: UNSETTLED_REFUND_STATUSES } } },
      ],
    },
    select: { id: true },
    take: batchSize,
  });

  let filesRemoved = 0;
  for (const order of orders) {
    filesRemoved += await purgeOrderFiles(order.id);
  }

  const tickets = await prisma.ticket.findMany({
    where: {
      status: { in: ['RESOLVED', 'CLOSED'] },
      attachmentsCleanedAt: null,
    },
    select: { id: true },
    take: batchSize,
  });

  for (const ticket of tickets) {
    filesRemoved += await purgeTicketAttachments(ticket.id);
  }

  return {
    ordersPurged: orders.length,
    ticketsPurged: tickets.length,
    filesRemoved,
  };
}
