import type { PrintColor } from '@prisma/client';

/**
 * Canonical order pricing.
 *
 * The server is the price authority: it writes `totalPrice` onto the order and
 * that is the figure charged through Razorpay. The frontend mirrors this logic
 * in `utils/pricing.ts` purely to show a live estimate, and the two MUST agree —
 * if you change a rule here, change it there.
 *
 * Every amount is paise.
 */

/** Shop rates, in paise per page. */
export interface ShopRates {
  bwPerPage: number;
  colorPerPage: number;
}

export interface PriceableFile {
  pageCount: number;
  color: PrintColor;
  copies: number;
  doubleSided: boolean;
}

export interface PriceBreakdown {
  pageCost: number;
  baseFee: number;
  totalPrice: number;
}

/**
 * Double-sided printing bills at 1.5x the single-side rate per sheet rather
 * than 2x, which is the discount that makes it worth choosing.
 */
const DOUBLE_SIDED_SHEET_MULTIPLIER = 1.5;

/** Page cost at or below which a Student Pass waives the base fee (₹30). */
const STUDENT_PASS_FEE_WAIVER_CEILING = 3000;

/** How long a Student Pass lasts from activation. */
const PASS_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether a Student Pass is still live.
 *
 * Here rather than beside either caller because a pass is a pricing input, and
 * it had grown two independent copies on this side — one in `order.service`
 * deciding what to charge, one in `payment.service` deciding whether a second
 * pass may be sold. Two implementations of one rule disagree eventually, and
 * the disagreement here is a student either charged a fee they paid to avoid or
 * sold a pass that overwrites the one they are still using.
 *
 * `utils/pricing.ts` mirrors this for the live estimate in the browser; that
 * one cannot be shared, and has to be kept in step by hand.
 */
export function isStudentPassActive(
  hasPass?: boolean | null,
  activatedAt?: Date | null
): boolean {
  if (!hasPass || !activatedAt) return false;
  return Date.now() < activatedAt.getTime() + PASS_DURATION_MS;
}

/**
 * Platform fee on top of page cost. Thresholds read as ₹5 / ₹30 / ₹70 and the
 * fees as ₹2 / ₹3 / ₹4 / ₹5.
 */
export function calculateBaseFee(pageCostPaise: number): number {
  if (pageCostPaise <= 0) return 0;
  if (pageCostPaise <= 500) return 200;
  if (pageCostPaise <= 3000) return 300;
  if (pageCostPaise <= 7000) return 400;
  return 500;
}

function fileCost(file: PriceableFile, rates: ShopRates): number {
  if (file.pageCount <= 0 || file.copies <= 0) return 0;

  const singleSideRate = file.color === 'COLOR' ? rates.colorPerPage : rates.bwPerPage;

  if (file.doubleSided && file.pageCount > 1) {
    const fullSheets = Math.floor(file.pageCount / 2);
    const remainderPages = file.pageCount % 2;
    const sheetRate = singleSideRate * DOUBLE_SIDED_SHEET_MULTIPLIER;
    const singleCopyCost = fullSheets * sheetRate + remainderPages * singleSideRate;
    // The 1.5x multiplier can land on a half-paisa for odd rates, and paise are
    // the smallest unit we can actually charge.
    return Math.round(singleCopyCost * file.copies);
  }

  return Math.round(file.pageCount * singleSideRate * file.copies);
}

/**
 * Price an order. One base fee applies to the combined page cost, regardless of
 * how many files it spans.
 */
export function calculateOrderPrice(
  files: PriceableFile[],
  rates: ShopRates,
  hasStudentPass = false
): PriceBreakdown {
  const pageCost = files.reduce((sum, file) => sum + fileCost(file, rates), 0);

  let baseFee = calculateBaseFee(pageCost);
  if (hasStudentPass && pageCost <= STUDENT_PASS_FEE_WAIVER_CEILING) {
    baseFee = 0;
  }

  return { pageCost, baseFee, totalPrice: pageCost + baseFee };
}
