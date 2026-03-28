import { PrintOptions, ShopPricing, PrintColor, DocumentOrder } from '../types';

// --- Student Pass Expiry Helpers ---
const PASS_DURATION_DAYS = 30;

/**
 * Checks whether a student pass is still active (within 30 days of activation).
 * Returns false if no activation date exists or if 30 days have elapsed.
 */
export const isStudentPassActive = (hasPass?: boolean, activatedAt?: string): boolean => {
  if (!hasPass || !activatedAt) return false;
  const activationDate = new Date(activatedAt).getTime();
  if (isNaN(activationDate)) return false;
  const expiryDate = activationDate + PASS_DURATION_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() < expiryDate;
};

/**
 * Returns the number of days remaining on a student pass.
 * Returns 0 if expired or no activation date.
 */
export const getStudentPassDaysRemaining = (activatedAt?: string): number => {
  if (!activatedAt) return 0;
  const activationDate = new Date(activatedAt).getTime();
  if (isNaN(activationDate)) return 0;
  const expiryDate = activationDate + PASS_DURATION_DAYS * 24 * 60 * 60 * 1000;
  const remaining = expiryDate - Date.now();
  return remaining > 0 ? Math.ceil(remaining / (24 * 60 * 60 * 1000)) : 0;
};

/**
 * Returns the expiry date of a student pass as a Date object.
 */
export const getStudentPassExpiryDate = (activatedAt?: string): Date | null => {
  if (!activatedAt) return null;
  const activationDate = new Date(activatedAt).getTime();
  if (isNaN(activationDate)) return null;
  return new Date(activationDate + PASS_DURATION_DAYS * 24 * 60 * 60 * 1000);
};

// --- Helper: New Base Fee Logic ---
export const calculateBaseFee = (pageCost: number): number => {
  if (pageCost <= 0) return 0;
  if (pageCost <= 5) return 2;
  if (pageCost <= 30) return 3;
  if (pageCost <= 70) return 4;
  return 5;
};

/**
 * Calculate price for a single-file order (legacy path).
 * Uses the shared color setting from printOptions.
 */
export const calculateOrderPrice = (
  printOptions: PrintOptions,
  shopPricing: ShopPricing,
  hasStudentPass: boolean = false
): DocumentOrder['priceDetails'] => {
  const { pages, copies, color, doubleSided } = printOptions;
  if (pages <= 0 || copies <= 0) return { pageCost: 0, baseFee: 0, totalPrice: 0 };

  const singleSideRate = color === PrintColor.COLOR ? shopPricing.colorPerPage : shopPricing.bwPerPage;

  let totalCost;
  if (doubleSided && pages > 1) {
    const fullSheets = Math.floor(pages / 2);
    const remainderPages = pages % 2;
    const doubleSideSheetRate = singleSideRate * 1.5;
    const singleCopyCost = (fullSheets * doubleSideSheetRate) + (remainderPages * singleSideRate);
    totalCost = singleCopyCost * copies;
  } else {
    totalCost = pages * singleSideRate * copies;
  }

  const calculatedPageCost = totalCost;

  let calculatedBaseFee = calculateBaseFee(calculatedPageCost);
  if (hasStudentPass && calculatedPageCost <= 30) {
    calculatedBaseFee = 0;
  }

  const calculatedTotalPrice = calculatedPageCost + calculatedBaseFee;

  return {
    pageCost: parseFloat(calculatedPageCost.toFixed(2)),
    baseFee: parseFloat(calculatedBaseFee.toFixed(2)),
    totalPrice: parseFloat(calculatedTotalPrice.toFixed(2)),
  };
};

/**
 * Calculate the page cost for a single file with its own color setting.
 */
const calculateFilePageCost = (
  pageCount: number,
  color: PrintColor,
  copies: number,
  doubleSided: boolean,
  shopPricing: ShopPricing
): number => {
  if (pageCount <= 0 || copies <= 0) return 0;

  const singleSideRate = color === PrintColor.COLOR ? shopPricing.colorPerPage : shopPricing.bwPerPage;

  if (doubleSided && pageCount > 1) {
    const fullSheets = Math.floor(pageCount / 2);
    const remainderPages = pageCount % 2;
    const doubleSideSheetRate = singleSideRate * 1.5;
    const singleCopyCost = (fullSheets * doubleSideSheetRate) + (remainderPages * singleSideRate);
    return singleCopyCost * copies;
  }

  return pageCount * singleSideRate * copies;
};

/**
 * Calculate price for a multi-file order.
 * Each file has its own color, copies, and double-sided setting.
 * One base fee applied to the combined page cost.
 */
export const calculateMultiFileOrderPrice = (
  files: { pageCount: number; color: PrintColor; copies: number; doubleSided: boolean }[],
  shopPricing: ShopPricing,
  hasStudentPass: boolean = false
): DocumentOrder['priceDetails'] => {
  if (files.length === 0) {
    return { pageCost: 0, baseFee: 0, totalPrice: 0 };
  }

  // Sum page costs across all files, each with its own settings
  let totalPageCost = 0;
  for (const file of files) {
    if (file.copies <= 0 || file.pageCount <= 0) continue;
    totalPageCost += calculateFilePageCost(
      file.pageCount,
      file.color,
      file.copies,
      file.doubleSided,
      shopPricing
    );
  }

  let calculatedBaseFee = calculateBaseFee(totalPageCost);
  if (hasStudentPass && totalPageCost <= 30) {
    calculatedBaseFee = 0;
  }

  const calculatedTotalPrice = totalPageCost + calculatedBaseFee;

  return {
    pageCost: parseFloat(totalPageCost.toFixed(2)),
    baseFee: parseFloat(calculatedBaseFee.toFixed(2)),
    totalPrice: parseFloat(calculatedTotalPrice.toFixed(2)),
  };
};
