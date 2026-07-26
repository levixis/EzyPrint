
export const SUPPORTED_FILE_TYPES = [
  // Documents
  'PDF', 'PPTX',
  // Images
  'JPG', 'JPEG', 'PNG', 'WEBP',
];

// Normalize file extensions that are aliases (e.g. JPG → JPEG for consistent storage)
export const FILE_EXTENSION_ALIASES: Record<string, string> = {
  'JPG': 'JPEG',
};

// MIME types for the file input accept attribute (better mobile support)
export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg', 'image/png', 'image/webp',
];

// Default pricing for new shops, can be overridden by shop owner
export const DEFAULT_SHOP_PRICING = {
  bwPerPage: 1,
  colorPerPage: 3,
};

