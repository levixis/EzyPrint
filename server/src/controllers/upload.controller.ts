import { Request, Response, NextFunction } from 'express';
import * as storageService from '../services/storage.service';
import { ApiError } from '../utils/ApiError';
import path from 'path';

/**
 * Upload Controller — handles file upload, download, and delete operations.
 */

/**
 * POST /api/v1/uploads/single
 * Upload a single file. Returns the storage key and metadata.
 */
export async function uploadSingle(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) {
      throw ApiError.badRequest('No file uploaded. Use form field name "file".');
    }

    const folder = (req.query.folder as string) || 'orders';
    const result = await storageService.uploadFile(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      folder
    );

    res.status(201).json({
      success: true,
      message: 'File uploaded successfully',
      data: {
        storageKey: result.storageKey,
        originalName: result.originalName,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
        mode: result.mode,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/uploads/multiple
 * Upload multiple files (up to 10). Returns an array of storage results.
 */
export async function uploadMultiple(req: Request, res: Response, next: NextFunction) {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      throw ApiError.badRequest('No files uploaded. Use form field name "files".');
    }

    const folder = (req.query.folder as string) || 'orders';
    const results = await Promise.all(
      files.map((file) =>
        storageService.uploadFile(file.buffer, file.originalname, file.mimetype, folder)
      )
    );

    res.status(201).json({
      success: true,
      message: `${results.length} file(s) uploaded successfully`,
      data: {
        files: results.map((r) => ({
          storageKey: r.storageKey,
          originalName: r.originalName,
          mimeType: r.mimeType,
          sizeBytes: r.sizeBytes,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/uploads/url/:storageKey
 * Get a download URL for a file (pre-signed for S3, local API path for local mode).
 */
export async function getDownloadUrl(req: Request, res: Response, next: NextFunction) {
  try {
    const storageKey = decodeURIComponent(req.params.storageKey as string);
    if (!storageKey) throw ApiError.badRequest('Storage key is required');

    const downloadInfo = await storageService.getDownloadUrl(storageKey);

    res.json({
      success: true,
      data: downloadInfo,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/uploads/download/*
 * Serve a file directly (local mode only — S3 uses pre-signed URLs).
 * Streams the file to the client with proper Content-Type.
 */
export async function downloadFile(req: Request, res: Response, next: NextFunction) {
  try {
    const { folder, fileName } = req.params;
    const storageKey = `${folder}/${fileName}`;
    if (!folder || !fileName) throw ApiError.badRequest('Storage key is required');

    const buffer = await storageService.getFileBuffer(storageKey);

    // Determine content type from extension
    const ext = path.extname(storageKey).toLowerCase();
    const contentTypeMap: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.txt': 'text/plain',
    };

    const contentType = contentTypeMap[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/v1/uploads/:storageKey
 * Delete a file from storage.
 */
export async function deleteFileHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const storageKey = decodeURIComponent(req.params.storageKey as string);
    if (!storageKey) throw ApiError.badRequest('Storage key is required');

    await storageService.deleteFile(storageKey);

    res.json({
      success: true,
      message: 'File deleted successfully',
    });
  } catch (error) {
    next(error);
  }
}
