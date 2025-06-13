// User IDs are now dynamic, managed by authentication
// export const STUDENT_USER_ID = 'StudentUser001';
// export const SHOP_USER_ID = 'ShopOwner001';

// Static pricing constants are removed.
// Base fee is now calculated by a tiered logic function.
// Per-page prices are set by individual shops.

export const SUPPORTED_FILE_TYPES = ['PDF', 'DOCX', 'PPTX', 'TXT', 'JPEG', 'PNG'];

// Default pricing for new shops, can be overridden by shop owner
export const DEFAULT_SHOP_PRICING = {
  bwPerPage: 1,
  colorPerPage: 3,
};
