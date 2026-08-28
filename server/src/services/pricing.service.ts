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
export const PASS_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

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
 * The lowest per-page rate a shop may set, other than free.
 *
 * This exists because the rupees-as-paise unit bug has a second entry path that
 * the signup fix did not close. The conversion from what an owner types to what
 * is stored happens in the browser (`rupeesToPaise` in the settings modal); the
 * server has only ever checked `>= 0`, so any caller sending rupees — an old
 * bundle, a cached client, a direct API call — writes rupees into a paise
 * column and the shop silently charges a hundredth of its intended price.
 *
 * 50 paise is chosen because it sits below any real price (the schema defaults
 * are 100 and 300) and above everything a plausible rupee entry produces: ₹1
 * through ₹49 land as 1–49 paise, and every one of them is caught.
 *
 * Zero stays legal and is deliberately not treated as suspicious — a shop
 * running free black-and-white and charging only for colour is a real offer,
 * and `calculateBaseFee` already handles a zero page cost.
 */
export const MIN_CHARGEABLE_PAGE_RATE_PAISE = 50;

/**
 * Whether a per-page rate is one a shop could have meant.
 *
 * Shared by the request schema and the service write site rather than living in
 * one of them: the schema is the friendly rejection, the write site is the
 * control that holds however the call arrives.
 */
export function isUsablePageRate(paise: number): boolean {
  return paise === 0 || paise >= MIN_CHARGEABLE_PAGE_RATE_PAISE;
}

/**
 * The floor, phrased for the person who typed it.
 *
 * Deliberately says rupees and never mentions paise. The shop settings form
 * takes rupees and converts (`rupeesToPaise`), so the owner has never seen a
 * paise figure in their life — and the first version of this message read
 * "Prices are in paise — ₹1.00 a page is 100, not 1", which invites an owner
 * looking at a rupees field to type 100 and set their price to ₹100 a page.
 * A validation message that explains the storage unit to someone typing in a
 * different unit is not a hint, it is a trap.
 *
 * Built from the constant so the number in the sentence cannot drift from the
 * number being enforced.
 */
export function pageRateFloorMessage(label: 'B/W' | 'Colour'): string {
  return (
    `Minimum ${label} price is ₹${(MIN_CHARGEABLE_PAGE_RATE_PAISE / 100).toFixed(2)} per page. ` +
    `Enter 0 to offer it free.`
  );
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
