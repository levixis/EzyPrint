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

// ─────────────────────────────────────────────────────────────
// PRICING
//
// All amounts are paise. This is a MIRROR of the authoritative implementation
// in server/src/services/pricing.service.ts — the server writes the price that
// is actually charged, and these functions exist only to show a live estimate
// while the student configures their order. If you change a rule in one, change
// it in the other, or the quote will not match the charge.
// ─────────────────────────────────────────────────────────────

/** Double-sided bills at 1.5x the single-side rate per sheet, not 2x. */
const DOUBLE_SIDED_SHEET_MULTIPLIER = 1.5;

/** Page cost at or below which a Student Pass waives the base fee (₹30). */
const STUDENT_PASS_FEE_WAIVER_CEILING = 3000;

/** Platform fee on page cost. Thresholds are ₹5 / ₹30 / ₹70; fees ₹2 / ₹3 / ₹4 / ₹5. */
export const calculateBaseFee = (pageCostPaise: number): number => {
  if (pageCostPaise <= 0) return 0;
  if (pageCostPaise <= 500) return 200;
  if (pageCostPaise <= 3000) return 300;
  if (pageCostPaise <= 7000) return 400;
  return 500;
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

  const pageCost = calculateFilePageCost(pages, color, copies, doubleSided, shopPricing);

  let baseFee = calculateBaseFee(pageCost);
  if (hasStudentPass && pageCost <= STUDENT_PASS_FEE_WAIVER_CEILING) {
    baseFee = 0;
  }

  return { pageCost, baseFee, totalPrice: pageCost + baseFee };
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
    const sheetRate = singleSideRate * DOUBLE_SIDED_SHEET_MULTIPLIER;
    const singleCopyCost = (fullSheets * sheetRate) + (remainderPages * singleSideRate);
    // The 1.5x multiplier can land on a half-paisa for odd rates.
    return Math.round(singleCopyCost * copies);
  }

  return Math.round(pageCount * singleSideRate * copies);
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

  let baseFee = calculateBaseFee(totalPageCost);
  if (hasStudentPass && totalPageCost <= STUDENT_PASS_FEE_WAIVER_CEILING) {
    baseFee = 0;
  }

  return { pageCost: totalPageCost, baseFee, totalPrice: totalPageCost + baseFee };
};
