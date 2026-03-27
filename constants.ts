// User IDs are now dynamic, managed by authentication
// export const STUDENT_USER_ID = 'StudentUser001';
// export const SHOP_USER_ID = 'ShopOwner001';

// Static pricing constants are removed.
// Base fee is now calculated by a tiered logic function.
// Per-page prices are set by individual shops.

export const SUPPORTED_FILE_TYPES = [
  // Documents
  'PDF', 'DOC', 'DOCX', 'PPT', 'PPTX', 'XLS', 'XLSX', 'TXT',
  // Images
  'JPG', 'JPEG', 'PNG', 'HEIC', 'HEIF', 'WEBP', 'GIF', 'BMP', 'TIFF', 'SVG',
];

// Normalize file extensions that are aliases (e.g. JPG → JPEG for consistent storage)
export const FILE_EXTENSION_ALIASES: Record<string, string> = {
  'JPG': 'JPEG',
  'HEIF': 'HEIC',
  'TIFF': 'TIF',
};

// MIME types for the file input accept attribute (better mobile support)
export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff', 'image/svg+xml',
];

// Default pricing for new shops, can be overridden by shop owner
export const DEFAULT_SHOP_PRICING = {
  bwPerPage: 1,
  colorPerPage: 3,
};

// Admin emails — users with these emails are auto-detected as admins on login
export const ADMIN_EMAILS: string[] = [
  'harshvardhanjha339@gmail.com',
];
