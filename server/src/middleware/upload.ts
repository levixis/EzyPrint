import multer from 'multer';
import { ApiError } from '../utils/ApiError';

/**
 * Multer configuration — handles multipart/form-data file uploads.
 *
 * Files are stored in memory (buffer) and then passed to our storage
 * service which handles local or S3 persistence.
 *
 * Limits:
 * - 20MB per file
 * - 10 files per request (for multi-file orders)
 * - Only PDF, images, and common doc types allowed
 */

const ALLOWED_MIMETYPES = [
  // PDF
  'application/pdf',
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // Documents
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // Text
  'text/plain',
];

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_FILES = 10;

/**
 * Memory storage — files are kept in RAM as Buffer objects.
 * This is fine for files ≤ 20MB. For larger files, switch to disk storage.
 */
const storage = multer.memoryStorage();

/**
 * File filter — rejects files with disallowed MIME types.
 */
const fileFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, `File type '${file.mimetype}' is not allowed. Accepted: PDF, images, DOC, PPT, XLS, TXT`));
  }
};

/**
 * Pre-configured Multer instance.
 */
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES,
  },
});

/**
 * Middleware for single file upload.
 * Usage: router.post('/upload', uploadSingle, controller.uploadFile)
 * Access file via req.file
 */
export const uploadSingle = upload.single('file');

/**
 * Middleware for multiple file upload (up to 10 files).
 * Usage: router.post('/upload-many', uploadMultiple, controller.uploadFiles)
 * Access files via req.files
 */
export const uploadMultiple = upload.array('files', MAX_FILES);

export { MAX_FILE_SIZE, MAX_FILES, ALLOWED_MIMETYPES };
