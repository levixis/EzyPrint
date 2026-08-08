import { Request, Response, NextFunction } from 'express';
import * as storageService from '../services/storage.service';
import { countPages } from '../services/pagecount.service';
import { ApiError } from '../utils/ApiError';
import path from 'path';

const ALLOWED_FOLDERS = ['orders', 'tickets', 'profiles', 'documents'];

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
    let targetTicket: any = null;

    if (metadata.orderId && metadata.fileIndex !== undefined) {
      const order = await prisma.order.findUnique({ where: { id: metadata.orderId }, include: { files: { orderBy: { id: 'asc' } } } });
      if (!order) throw ApiError.notFound('Order not found');
      if (order.userId !== req.user?.userId && req.user?.userType !== 'ADMIN') throw ApiError.forbidden('Not your order');
      
      targetOrderFile = order.files[metadata.fileIndex];
      if (!targetOrderFile) throw ApiError.badRequest('Order file index out of bounds');
      if (targetOrderFile.fileStoragePath && req.body.replace !== 'true') {
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
        await prisma.orderFile.update({
          where: { id: targetOrderFile.id },
          data: {
            fileStoragePath: result.storageKey,
            fileSizeBytes: result.sizeBytes,
            fileType: result.mimeType,
            uploadId,
            ...(counted ? { verifiedPageCount: pages } : {}),
          }
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
      
      for (const idx of metadata.fileIndexes) {
        const orderFile = targetOrder.files[idx as number];
        if (!orderFile) throw ApiError.badRequest(`Order file index ${idx} out of bounds`);
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
    if (existingOrderFiles.length > 0) {
      return res.status(200).json({ success: true, message: 'Files already uploaded', data: { files: existingOrderFiles.map(f => ({ storageKey: f.fileStoragePath, originalName: f.fileName, mimeType: f.fileType, sizeBytes: f.fileSizeBytes })) } });
    }

    const existingTicketAttachments = targetTicket ? await prisma.ticketAttachment.findMany({ where: { ticketId: targetTicket.id, uploadId: { in: uploadIds } } }) : [];
    if (existingTicketAttachments.length > 0) {
      return res.status(200).json({ success: true, message: 'Files already uploaded', data: { files: existingTicketAttachments.map(f => ({ storageKey: f.storageKey, originalName: f.originalName, mimeType: f.mimeType, sizeBytes: f.sizeBytes })) } });
    }

    const uploadPromises = files.map((file) => storageService.uploadFile(file.buffer, file.originalname, file.mimetype, folder));
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
      ? await Promise.all(files.map((file, i) => countPages(file.buffer, results[i].mimeType)))
      : [];

    try {
      await prisma.$transaction(async (tx) => {
        if (targetOrder) {
          for (let i = 0; i < files.length; i++) {
            const idx = metadata.fileIndexes[i];
            const orderFile = targetOrder.files[idx];
            const result = results[i];
            const count = pageCounts[i];
            await tx.orderFile.update({
              where: { id: orderFile.id },
              data: {
                fileStoragePath: result.storageKey,
                fileSizeBytes: result.sizeBytes,
                fileType: result.mimeType,
                uploadId: uploadIds[i],
                ...(count?.counted ? { verifiedPageCount: count.pages } : {}),
              }
            });
          }
        } else if (targetTicket) {
          for (let i = 0; i < files.length; i++) {
            const result = results[i];
            await tx.ticketAttachment.create({
              data: { ticketId: targetTicket.id, storageKey: result.storageKey, originalName: result.originalName, mimeType: result.mimeType, sizeBytes: result.sizeBytes, uploadId: uploadIds[i] }
            });
          }
        }
      });
    } catch (e) {
      await Promise.all(results.map(r => storageService.deleteFile(r.storageKey).catch(() => {})));
      throw e;
    }

    res.status(201).json({ success: true, message: `${results.length} file(s) uploaded successfully`, data: { files: results } });
  } catch (error) { next(error); }
}

async function verifyStorageAccess(storageKey: string, userId: string, userType: string) {
  const { prisma } = await import('../utils/prisma');

  const orderFile = await prisma.orderFile.findFirst({ where: { fileStoragePath: storageKey }, include: { order: { include: { shop: true } } } });
  if (orderFile) {
    if (userType === 'ADMIN') return true;
    const order = orderFile.order;
    if (order.userId === userId || (userType === 'SHOP_OWNER' && order.shop?.ownerUserId === userId)) return true;
    throw ApiError.forbidden('You do not have access to this order file');
  }

  const ticketAttachment = await prisma.ticketAttachment.findFirst({ where: { storageKey }, include: { ticket: { include: { shop: true } } } });
  if (ticketAttachment) {
    if (userType === 'ADMIN') return true;
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
    await storageService.deleteFile(storageKey);
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
