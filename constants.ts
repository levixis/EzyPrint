
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

/**
 * Default pricing for new shops, in PAISE. Overridable by the shop owner.
 *
 * These read 100 and 300 (₹1.00 and ₹3.00), not 1 and 3. The rupee figures are
 * what they were before money became paise, and leaving them here — inert, but
 * one import away from being used — is how that bug gets reintroduced. The
 * server does not read this: `Shop.bwPerPage` / `colorPerPage` carry the same
 * defaults in schema.prisma, which is the authority.
 */
export const DEFAULT_SHOP_PRICING = {
  bwPerPage: 100,
  colorPerPage: 300,
};

