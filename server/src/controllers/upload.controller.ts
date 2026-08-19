import { Request, Response, NextFunction } from 'express';
import * as storageService from '../services/storage.service';
import { countPages } from '../services/pagecount.service';
import { ApiError } from '../utils/ApiError';
import { PAYMENT_CLAIM_TTL_MS } from '../services/payment.service';
import type { OrderStatus } from '@prisma/client';
import path from 'path';

const ALLOWED_FOLDERS = ['orders', 'tickets', 'profiles', 'documents'];

/**
 * The order statuses in which a student may still change which files an order
 * carries. Necessary, but on its own nowhere near sufficient — see below.
 */
const FILE_MUTABLE_ORDER_STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'PAYMENT_FAILED'];

/** The fields that decide whether an order's files are still the caller's to change. */
interface FileChangeGate {
  status: OrderStatus;
  razorpayOrderId: string | null;
  paymentAttemptedAt: Date | null;
}

/**
 * Refuse a file change once the order's price has been quoted to anybody.
 *
 * The status is the obvious signal and it is the wrong one. `PENDING_PAYMENT`
 * is the status for the *entire* time the Razorpay checkout sheet is open, so
 * a status-only guard leaves this sequence completely legal:
 *
 *   1. upload a 1-page file
 *   2. POST /payments/create-order — `repriceFromVerifiedPages` prices it at one
 *      page, a Razorpay order is created for that amount, and the row stays
 *      PENDING_PAYMENT
 *   3. upload `replace=true` with a 200-page file — status is still
 *      PENDING_PAYMENT, so a status guard waves it through
 *   4. pay the amount from step 2 — `payment.amount === order.totalPrice`, so
 *      the webhook fulfils it and hands the shop 200 pages
 *
 * Nothing in that sequence is an illegal state transition, which is exactly why
 * the status cannot be what protects it.
 *
 * What actually matters is whether a price has been *quoted*. That is true from
 * the moment `createPaymentOrder` claims the order — and it claims by setting
 * `paymentAttemptedAt`, *before* it calls Razorpay and writes
 * `razorpayOrderId`. Guarding on the id alone would leave that gap open, and it
 * is precisely the window an attacker would aim at. So both are checked:
 *
 *   - `razorpayOrderId` set  → a price is live at the gateway
 *   - `paymentAttemptedAt` within `PAYMENT_CLAIM_TTL_MS` → one is being quoted
 *
 * A lapsed claim releases the files again, using the same TTL
 * `createPaymentOrder` uses to decide it may reclaim a crashed attempt. If it
 * may take the order over, uploads may change it.
 *
 * This deliberately locks a PAYMENT_FAILED order that still holds its Razorpay
 * order, because the retry path *reuses* that order at its original amount. The
 * partial-upload retry that this could be confused with is unaffected: checkout
 * refuses while any file lacks a verified page count, so an order with an
 * unfilled slot can never be holding a Razorpay order.
 *
 * Admins keep the override — they resolve the cases that need a file changed
 * after the fact.
 */
function assertOrderAcceptsFileChanges(
  order: FileChangeGate,
  userType: string | undefined,
  verb: 'replaced' | 'removed'
): void {
  if (userType === 'ADMIN') return;

  if (!FILE_MUTABLE_ORDER_STATUSES.includes(order.status)) {
    throw ApiError.badRequest(
      `This order has already been sent to the shop, so its files can no longer be ${verb}.`
    );
  }

  const claimIsLive =
    order.paymentAttemptedAt !== null &&
    Date.now() - new Date(order.paymentAttemptedAt).getTime() < PAYMENT_CLAIM_TTL_MS;

  if (order.razorpayOrderId !== null || claimIsLive) {
    throw ApiError.badRequest(
      `This order is already at checkout, so its files can no longer be ${verb}. ` +
      `Cancel it and start a new order to change what you are printing — nothing has been charged.`
    );
  }
}

/**
 * Re-assert the gate inside the writing transaction, holding the order row.
 *
 * The check above reads the order and then, some milliseconds later, the file
 * is written — and in between, a concurrent `POST /payments/create-order` can
 * claim the order and quote a price for the file set as it was. Two requests
 * the same caller controls and can fire together, so the window is not
 * theoretical.
 *
 * `FOR UPDATE` takes the row lock that closes it. `createPaymentOrder`'s claim
 * is an `updateMany` against the same row, so the two serialise whichever way
 * they arrive:
 *
 *   - upload commits first → the claim then reprices from the new files, sees
 *     the total move, and stops with "please review and pay again"
 *   - claim commits first  → this blocks, then sees the live claim and refuses
 *
 * Both orderings end with the amount charged matching the files printed, which
 * is the only invariant that matters here.
 */
async function assertOrderStillAcceptsFileChanges(
  tx: { $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> },
  orderId: string,
  userType: string | undefined,
  verb: 'replaced' | 'removed'
): Promise<void> {
  if (userType === 'ADMIN') return;

  const rows = (await tx.$queryRaw`
    SELECT "status", "razorpayOrderId", "paymentAttemptedAt"
      FROM "orders"
     WHERE "id" = ${orderId}
       FOR UPDATE
  `) as FileChangeGate[];

  const current = rows[0];
  if (!current) throw ApiError.notFound('Order not found');

  assertOrderAcceptsFileChanges(current, userType, verb);
}

/**
 * POST /api/v1/uploads/single
 * Upload a single file. Returns the storage key and metadata.
 */
export async function uploadSingle(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw ApiError.badRequest('No file uploaded. Use form field name "file".');
    const folder = (req.query.folder as string) || 'orders';
    if (!ALLOWED_FOLDERS.includes(folder)) throw ApiError.badRequest('Invalid folder parameter');
    
    let metadata: any = {};
    if (req.body.metadata) {
      try { metadata = typeof req.body.metadata === 'string' ? JSON.parse(req.body.metadata) : req.body.metadata; }
      catch { /* malformed metadata falls back to {} — the upload itself is still valid */ }
    }
    
    const uploadId = req.body.uploadId;
    if (!uploadId) throw ApiError.badRequest('uploadId is required');

    const { prisma } = await import('../utils/prisma');
    let targetOrderFile: any = null;
    let targetOrderId: string | null = null;
    let targetTicket: any = null;

    if (metadata.orderId && metadata.fileIndex !== undefined) {
      const order = await prisma.order.findUnique({ where: { id: metadata.orderId }, include: { files: { orderBy: { id: 'asc' } } } });
      if (!order) throw ApiError.notFound('Order not found');
      if (order.userId !== req.user?.userId && req.user?.userType !== 'ADMIN') throw ApiError.forbidden('Not your order');
      
      targetOrderFile = order.files[metadata.fileIndex];
      if (!targetOrderFile) throw ApiError.badRequest('Order file index out of bounds');
      // Same upload arriving again is a retry, not an overwrite — it falls
      // through to the idempotent return below. Without this exception that
      // return was unreachable, because a slot filled by the attempt being
      // retried is exactly a slot with a storage path.
      if (
        targetOrderFile.uploadId !== uploadId &&
        targetOrderFile.fileStoragePath &&
        req.body.replace !== 'true'
      ) {
        throw ApiError.badRequest('Order file already linked. Pass replace=true to overwrite.');
      }
      
      // Scoped to the slot being filled, not to the id alone. `uploadId` is
      // minted by the browser, so a global lookup answers "has anyone anywhere
      // used this id" — and on a collision it would hand this caller another
      // order's storage key and skip linking their file, leaving their own
      // order with nothing attached.
      const existing = await prisma.orderFile.findUnique({ where: { uploadId } });
      if (existing && existing.fileStoragePath && existing.id === targetOrderFile.id) {
        return res.status(200).json({ success: true, message: 'File already uploaded', data: { storageKey: existing.fileStoragePath } });
      }

      // After the idempotent return, deliberately. A repeat of an upload that
      // already landed is not a change and must keep succeeding even if the
      // order has been paid for in the meantime — a client retrying through a
      // flaky connection while the webhook lands would otherwise be told its
      // own completed upload was forbidden. Only an actual mutation is refused.
      //
      // A cheap early refusal so a rejected request does not push bytes to R2
      // first. It is not the control: the re-check under the row lock, in the
      // transaction that does the write, is what actually holds.
      assertOrderAcceptsFileChanges(order, req.user?.userType, 'replaced');
      targetOrderId = order.id;
    } else if (metadata.ticketId) {
      targetTicket = await prisma.ticket.findUnique({ where: { id: metadata.ticketId }, include: { shop: true } });
      if (!targetTicket) throw ApiError.notFound('Ticket not found');
      if (req.user?.userType !== 'ADMIN' && targetTicket.raisedBy !== req.user?.userId && targetTicket.shop?.ownerUserId !== req.user?.userId) {
        throw ApiError.forbidden('Not your ticket');
      }
      
      // Same reasoning as the order branch: an id minted by one browser must
      // not resolve to an attachment on somebody else's ticket.
      const existing = await prisma.ticketAttachment.findUnique({ where: { uploadId } });
      if (existing && existing.ticketId === targetTicket.id) {
        return res.status(200).json({ success: true, message: 'File already uploaded', data: { storageKey: existing.storageKey } });
      }
    } else {
      throw ApiError.badRequest('Valid metadata containing orderId+fileIndex or ticketId is required');
    }

    const result = await storageService.uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype, folder);

    try {
      if (targetOrderFile) {
        // Counted from the bytes we received, not from what the client claimed.
        const { pages, counted } = await countPages(req.file.buffer, result.mimeType);
        // The gate is re-asserted here, holding the order row, so a checkout
        // that started while this file was being uploaded cannot have priced
        // the old file set and then had this one written underneath it.
        await prisma.$transaction(async (tx) => {
          await assertOrderStillAcceptsFileChanges(
            tx as never, targetOrderId as string, req.user?.userType, 'replaced'
          );
          await tx.orderFile.update({
            where: { id: targetOrderFile.id },
            data: {
              fileStoragePath: result.storageKey,
              fileSizeBytes: result.sizeBytes,
              fileType: result.mimeType,
              uploadId,
              ...(counted ? { verifiedPageCount: pages } : {}),
            }
          });
        });
      } else if (targetTicket) {
        await prisma.ticketAttachment.create({
          // messageId ties the file to the reply that carried it, so it renders
          // inside the conversation. Absent for files attached when the ticket
          // was raised — those belong to the ticket itself.
          data: { ticketId: targetTicket.id, messageId: metadata.messageId ?? null, storageKey: result.storageKey, originalName: result.originalName, mimeType: result.mimeType, sizeBytes: result.sizeBytes, uploadId }
        });
      }
    } catch (e) {
      await storageService.deleteFile(result.storageKey).catch(() => {});
      throw e;
    }

    res.status(201).json({ success: true, message: 'File uploaded successfully', data: { ...result } });
  } catch (error) { next(error); }
}

/**
 * POST /api/v1/uploads/multiple
 * Upload multiple files (up to 10).
 */
export async function uploadMultiple(req: Request, res: Response, next: NextFunction) {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) throw ApiError.badRequest('No files uploaded. Use form field name "files".');
    const folder = (req.query.folder as string) || 'orders';
    if (!ALLOWED_FOLDERS.includes(folder)) throw ApiError.badRequest('Invalid folder parameter');
    
    let metadata: any = {};
    if (req.body.metadata) {
      try { metadata = typeof req.body.metadata === 'string' ? JSON.parse(req.body.metadata) : req.body.metadata; }
      catch { /* malformed metadata falls back to {} — the upload itself is still valid */ }
    }
    
    let uploadIds: string[] = [];
    if (req.body.uploadIds) {
      try { uploadIds = typeof req.body.uploadIds === 'string' ? JSON.parse(req.body.uploadIds) : req.body.uploadIds; }
      catch { /* left empty; the length check below rejects the request with a clear reason */ }
    }
    
    if (!Array.isArray(uploadIds) || uploadIds.length !== files.length) {
      throw ApiError.badRequest('uploadIds array matching files length is required');
    }

    const { prisma } = await import('../utils/prisma');
    
    let targetOrder: any = null;
    let targetTicket: any = null;

    if (metadata.orderId && Array.isArray(metadata.fileIndexes) && metadata.fileIndexes.length === files.length) {
      targetOrder = await prisma.order.findUnique({ where: { id: metadata.orderId }, include: { files: { orderBy: { id: 'asc' } } } });
      if (!targetOrder) throw ApiError.notFound('Order not found');
      if (targetOrder.userId !== req.user?.userId && req.user?.userType !== 'ADMIN') throw ApiError.forbidden('Not your order');
      
      const uniqueIndexes = new Set(metadata.fileIndexes);
      if (uniqueIndexes.size !== metadata.fileIndexes.length) throw ApiError.badRequest('Duplicate fileIndexes');
      
      // `fileIndexes[i]`, `uploadIds[i]` and `files[i]` describe the same file.
      for (let i = 0; i < metadata.fileIndexes.length; i++) {
        const idx = metadata.fileIndexes[i] as number;
        const orderFile = targetOrder.files[idx];
        if (!orderFile) throw ApiError.badRequest(`Order file index ${idx} out of bounds`);

        // A slot already holding *this* upload is the same file arriving a
        // second time — a retry, which must be idempotent rather than an error.
        //
        // This check guards the one below, and without it a partial retry was a
        // dead end: the files that did land made their slots "already linked",
        // so the retry was rejected outright and the dedup below — the whole
        // mechanism for finishing a half-finished batch — was unreachable. The
        // student was told to re-upload and re-uploading produced the same
        // rejection, leaving the order permanently unpayable.
        if (orderFile.uploadId && orderFile.uploadId === uploadIds[i]) continue;

        if (orderFile.fileStoragePath && req.body.replace !== 'true') {
          throw ApiError.badRequest(`Order file at index ${idx} already linked. Pass replace=true.`);
        }
      }
    } else if (metadata.ticketId) {
      targetTicket = await prisma.ticket.findUnique({ where: { id: metadata.ticketId }, include: { shop: true } });
      if (!targetTicket) throw ApiError.notFound('Ticket not found');
      if (req.user?.userType !== 'ADMIN' && targetTicket.raisedBy !== req.user?.userId && targetTicket.shop?.ownerUserId !== req.user?.userId) {
        throw ApiError.forbidden('Not your ticket');
      }
    } else {
      throw ApiError.badRequest('Valid metadata containing orderId+fileIndexes or ticketId is required');
    }

    
    // Constrained to this order. Without `orderId` the dedup asks whether the
    // id has been used anywhere at all, and a browser-minted collision would
    // return another order's files and skip storing these ones.
    const existingOrderFiles = targetOrder ? await prisma.orderFile.findMany({ where: { orderId: targetOrder.id, uploadId: { in: uploadIds }, fileStoragePath: { not: null } } }) : [];
    const existingTicketAttachments = targetTicket ? await prisma.ticketAttachment.findMany({ where: { ticketId: targetTicket.id, uploadId: { in: uploadIds } } }) : [];

    // Short-circuit only when EVERY id has already landed.
    //
    // This used to return on the first match, and a partial retry is the whole
    // reason the dedup exists: a batch that stored 2 of 5 before the network
    // dropped came back, matched those 2, and answered "already uploaded" with
    // 2 files. The other 3 were never stored and the client saw success. Their
    // rows kept `verifiedPageCount` null, so checkout then refused with "we
    // could not read the page count — please re-upload", and re-uploading hit
    // this same early return. The order became permanently unpayable.
    const alreadyStored = new Set<string>([
      ...existingOrderFiles.map((f) => f.uploadId).filter((id): id is string => Boolean(id)),
      ...existingTicketAttachments.map((f) => f.uploadId).filter((id): id is string => Boolean(id)),
    ]);

    if (alreadyStored.size >= uploadIds.length) {
      const done = targetOrder
        ? existingOrderFiles.map(f => ({ storageKey: f.fileStoragePath, originalName: f.fileName, mimeType: f.fileType, sizeBytes: f.fileSizeBytes }))
        : existingTicketAttachments.map(f => ({ storageKey: f.storageKey, originalName: f.originalName, mimeType: f.mimeType, sizeBytes: f.sizeBytes }));
      return res.status(200).json({ success: true, message: 'Files already uploaded', data: { files: done } });
    }

    // Same rule as the single-file path, and in the same position relative to
    // the dedup: a batch that has already landed in full returns above and is
    // untouched by this, so only a real change to a paid order is refused.
    if (targetOrder) {
      assertOrderAcceptsFileChanges(targetOrder, req.user?.userType, 'replaced');
    }

    // Otherwise carry on with only the files still missing, keeping each one
    // paired with its uploadId and its target slot.
    const pending = files
      .map((file, i) => ({ file, uploadId: uploadIds[i] as string, fileIndex: targetOrder ? metadata.fileIndexes[i] : undefined }))
      .filter((item) => !alreadyStored.has(item.uploadId));

    const uploadPromises = pending.map(({ file }) => storageService.uploadFile(file.buffer, file.originalname, file.mimetype, folder));
    const settledResults = await Promise.allSettled(uploadPromises);
    
    const results: any[] = [];
    const failed: any[] = [];
    for (const r of settledResults) {
      if (r.status === 'fulfilled') results.push(r.value);
      else failed.push(r.reason);
    }
    
    if (failed.length > 0) {
      await Promise.allSettled(results.map(r => storageService.deleteFile(r.storageKey)));
      throw ApiError.internal('One or more files failed to upload to storage');
    }

    // Counted from the received bytes before the transaction, so parsing does
    // not hold a database transaction open.
    const pageCounts = targetOrder
      ? await Promise.all(pending.map(({ file }, i) => countPages(file.buffer, results[i].mimeType)))
      : [];

    try {
      await prisma.$transaction(async (tx) => {
        if (targetOrder) {
          // Under the row lock, for the same reason as the single-file path:
          // the check above happened before these bytes went to R2, and a
          // checkout can have started since.
          await assertOrderStillAcceptsFileChanges(
            tx as never, targetOrder.id, req.user?.userType, 'replaced'
          );
          for (let i = 0; i < pending.length; i++) {
            const orderFile = targetOrder.files[pending[i].fileIndex];
            const result = results[i];
            const count = pageCounts[i];
            await tx.orderFile.update({
              where: { id: orderFile.id },
              data: {
                fileStoragePath: result.storageKey,
                fileSizeBytes: result.sizeBytes,
                fileType: result.mimeType,
                uploadId: pending[i].uploadId,
                ...(count?.counted ? { verifiedPageCount: count.pages } : {}),
              }
            });
          }
        } else if (targetTicket) {
          for (let i = 0; i < pending.length; i++) {
            const result = results[i];
            await tx.ticketAttachment.create({
              data: { ticketId: targetTicket.id, storageKey: result.storageKey, originalName: result.originalName, mimeType: result.mimeType, sizeBytes: result.sizeBytes, uploadId: pending[i].uploadId }
            });
          }
        }
      });
    } catch (e) {
      await Promise.all(results.map(r => storageService.deleteFile(r.storageKey).catch(() => {})));
      throw e;
    }

    // Everything the caller asked about: what this call stored, plus whatever a
    // previous attempt had already stored. A partial retry has to come back
    // with the whole set or the client cannot tell it is now complete.
    const previously = targetOrder
      ? existingOrderFiles.map(f => ({ storageKey: f.fileStoragePath, originalName: f.fileName, mimeType: f.fileType, sizeBytes: f.fileSizeBytes }))
      : existingTicketAttachments.map(f => ({ storageKey: f.storageKey, originalName: f.originalName, mimeType: f.mimeType, sizeBytes: f.sizeBytes }));

    res.status(201).json({
      success: true,
      message: `${results.length} file(s) uploaded successfully`,
      data: { files: [...previously, ...results] },
    });
  } catch (error) { next(error); }
}

/**
 * Decide whether `userId` may touch the object behind `storageKey`.
 *
 * Every row referencing the key is considered, not just the first one found.
 *
 * `findFirst` was the original shape, and it made authorisation depend on which
 * of several matching rows Postgres happened to return — an order that is not
 * defined without an ORDER BY. If a key were ever referenced by two rows, the
 * caller owning either one could be handed access to a file belonging to the
 * other. Creating that second row used to be a request the client could make;
 * `createOrderSchema` no longer accepts a storage key, and this is the second
 * half of the same fix, because a duplicate arriving by any other route — a
 * backfill, a support script, a future feature — must not become an access
 * grant. Deny wins over allow.
 */
async function verifyStorageAccess(storageKey: string, userId: string, userType: string) {
  const { prisma } = await import('../utils/prisma');

  const [orderFiles, ticketAttachments] = await Promise.all([
    prisma.orderFile.findMany({ where: { fileStoragePath: storageKey }, include: { order: { include: { shop: true } } } }),
    prisma.ticketAttachment.findMany({ where: { storageKey }, include: { ticket: { include: { shop: true } } } }),
  ]);

  if (orderFiles.length === 0 && ticketAttachments.length === 0) {
    throw ApiError.forbidden('File not found or unlinked');
  }

  if (userType === 'ADMIN') return true;

  // A key referenced more than once cannot be authorised on ownership, because
  // "the owner" is ambiguous — exactly the condition an attacker would engineer.
  if (orderFiles.length + ticketAttachments.length > 1) {
    console.error(
      `⚠️ Storage key ${storageKey} is referenced by ${orderFiles.length + ticketAttachments.length} rows — ` +
      `refusing access and flagging for review.`
    );
    throw ApiError.forbidden('This file cannot be served right now. Our team has been alerted.');
  }

  const orderFile = orderFiles[0];
  if (orderFile) {
    const order = orderFile.order;
    if (order.userId === userId || (userType === 'SHOP_OWNER' && order.shop?.ownerUserId === userId)) return true;
    throw ApiError.forbidden('You do not have access to this order file');
  }

  const ticketAttachment = ticketAttachments[0];
  if (ticketAttachment) {
    const ticket = ticketAttachment.ticket;
    if (ticket.raisedBy === userId || (userType === 'SHOP_OWNER' && ticket.shop?.ownerUserId === userId)) return true;
    throw ApiError.forbidden('You do not have access to this ticket attachment');
  }

  throw ApiError.forbidden('File not found or unlinked');
}

/**
 * GET /api/v1/uploads/url/:storageKey
 */
export async function getDownloadUrl(req: Request, res: Response, next: NextFunction) {
  try {
    const storageKey = decodeURIComponent(req.params.storageKey as string);
    if (!storageKey) throw ApiError.badRequest('Storage key is required');
    if (!req.user) throw ApiError.unauthorized();
    await verifyStorageAccess(storageKey, req.user.userId, req.user.userType);
    const downloadInfo = await storageService.getDownloadUrl(storageKey);
    res.json({ success: true, data: downloadInfo });
  } catch (error) { next(error); }
}

/**
 * GET /api/v1/uploads/download/:storageKey
 */
export async function downloadFile(req: Request, res: Response, next: NextFunction) {
  try {
    const storageKey = decodeURIComponent(req.params.storageKey as string);
    if (!storageKey) throw ApiError.badRequest('Storage key is required');
    if (!req.user) throw ApiError.unauthorized();
    await verifyStorageAccess(storageKey, req.user.userId, req.user.userType);
    
    const buffer = await storageService.getFileBuffer(storageKey);
    const ext = path.extname(storageKey).toLowerCase();
    const contentTypeMap: Record<string, string> = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.txt': 'text/plain' };
    const contentType = contentTypeMap[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error) { next(error); }
}

/**
 * DELETE /api/v1/uploads/:storageKey
 */
export async function deleteFileHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const storageKey = decodeURIComponent(req.params.storageKey as string);
    if (!storageKey) throw ApiError.badRequest('Storage key is required');
    if (!req.user) throw ApiError.unauthorized();
    await verifyStorageAccess(storageKey, req.user.userId, req.user.userType);

    const { prisma } = await import('../utils/prisma');

    // Only while the order is still the student's to change. Past
    // PENDING_PAYMENT the shop has been given a job to print, and letting the
    // file vanish from under them leaves an order nobody can fulfil and nobody
    // can explain. Admins keep the override.
    const orderFile = await prisma.orderFile.findFirst({
      where: { fileStoragePath: storageKey },
      select: {
        id: true,
        orderId: true,
        // The same three fields the upload path gates on. Removing a file from
        // an order that is at checkout is the same problem as replacing one:
        // the price was quoted from this file set.
        order: { select: { status: true, razorpayOrderId: true, paymentAttemptedAt: true } },
      },
    });

    if (orderFile) {
      assertOrderAcceptsFileChanges(orderFile.order, req.user.userType, 'removed');
    }

    await storageService.deleteFile(storageKey);

    // The row is the source of truth for whether a file exists — the retention
    // sweep, the shop's download button and `hasOpenDispute` all read it. This
    // used to end at the line above, so the object went and the row kept
    // pointing at it: the sweep re-deleted a key that was already gone, and the
    // shop's download returned a 500 instead of "this file is no longer here".
    if (orderFile) {
      await prisma.orderFile.update({
        where: { id: orderFile.id },
        data: { isFileDeleted: true, fileStoragePath: null },
      });
      // The order carries a denormalised copy of the first file's path.
      await prisma.order.updateMany({
        where: { id: orderFile.orderId, fileStoragePath: storageKey },
        data: { isFileDeleted: true, fileStoragePath: null },
      });
    } else {
      await prisma.ticketAttachment.deleteMany({ where: { storageKey } });
    }

    res.json({ success: true, message: 'File deleted successfully' });
  } catch (error) { next(error); }
}

// Clean up orphaned files in S3 if they aren't linked in the DB
export async function cleanupOrphans(req: Request, res: Response, next: NextFunction) {
  try {
    // Only admins or system chron job
    if (req.user?.userType !== 'ADMIN') throw ApiError.forbidden();
    // In a real scenario, you'd list objects in S3 and check DB.
    res.json({ success: true, message: 'Cleanup job triggered' });
  } catch (error) { next(error); }
}
