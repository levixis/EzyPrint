import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { blockPathTraversal } from '../middleware/security';
import { uploadSingle, uploadMultiple } from '../middleware/upload';
import * as uploadController from '../controllers/upload.controller';

const router = Router();

/**
 * POST /api/v1/uploads/single
 * Upload a single file. Query: ?folder=orders (default: 'orders')
 * Form field: 'file'
 */
router.post('/single', authenticate, uploadSingle, uploadController.uploadSingle);

/**
 * POST /api/v1/uploads/multiple
 * Upload multiple files (up to 10). Query: ?folder=orders
 * Form field: 'files'
 */
router.post('/multiple', authenticate, uploadMultiple, uploadController.uploadMultiple);

/**
 * GET /api/v1/uploads/url/:storageKey
 * Get a download URL for a file by storage key.
 * The storageKey is URL-encoded (e.g., orders%2F123-abc-file.pdf).
 */
router.get('/url/:storageKey', authenticate, blockPathTraversal, uploadController.getDownloadUrl);

/**
 * GET /api/v1/uploads/download/:storageKey
 * Serve the actual file (local mode). S3 mode uses pre-signed URLs directly.
 */
router.get('/download/:storageKey', authenticate, blockPathTraversal, uploadController.downloadFile);

/**
 * DELETE /api/v1/uploads/:storageKey
 * Delete a file from storage by storage key (URL-encoded).
 */
router.delete('/:storageKey', authenticate, blockPathTraversal, uploadController.deleteFileHandler);

export default router;
