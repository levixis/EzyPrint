import { DocumentOrder, OrderFile } from '../types';

/**
 * Backward-compatible helper: returns the files array from an order.
 * If the order uses the new `files[]` array, returns it directly.
 * If it's a legacy single-file order, constructs a single-element array from the legacy fields.
 */
export const getOrderFiles = (order: DocumentOrder): OrderFile[] => {
  if (order.files && order.files.length > 0) {
    return order.files;
  }
  // Legacy fallback: construct OrderFile from single-file fields
  return [{
    fileName: order.fileName,
    fileType: order.fileType,
    fileStoragePath: order.fileStoragePath,
    fileSizeBytes: order.fileSizeBytes,
    isFileDeleted: order.isFileDeleted,
    pageCount: order.printOptions.pages,
    color: order.printOptions.color,
    copies: order.printOptions.copies,
    doubleSided: order.printOptions.doubleSided,
  }];
};

/**
 * Returns a display-friendly name for an order's files.
 * e.g., "report.pdf" or "report.pdf +2 more"
 */
export const getOrderDisplayName = (order: DocumentOrder): string => {
  const files = getOrderFiles(order);
  if (files.length === 0) return order.fileName || 'Unknown file';
  if (files.length === 1) return files[0].fileName;
  return `${files[0].fileName} +${files.length - 1} more`;
};

/**
 * Returns the total file size across all files in an order.
 */
export const getTotalFileSize = (order: DocumentOrder): number => {
  const files = getOrderFiles(order);
  return files.reduce((sum, f) => sum + (f.fileSizeBytes || 0), 0);
};

/**
 * Returns the total page count across all files in an order.
 */
export const getTotalPageCount = (order: DocumentOrder): number => {
  const files = getOrderFiles(order);
  return files.reduce((sum, f) => sum + f.pageCount, 0);
};

/**
 * Checks if the order has any files that haven't been deleted yet.
 */
export const hasDownloadableFiles = (order: DocumentOrder): boolean => {
  const files = getOrderFiles(order);
  return files.some(f => f.fileStoragePath && !f.isFileDeleted);
};
