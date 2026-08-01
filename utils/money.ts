/**
 * Money helpers.
 *
 * Every monetary value crossing the API — balances, ledger amounts, order
 * totals, payout amounts, shop rates — is an integer number of paise. Rupees
 * exist only at the display boundary and in the inputs a human types.
 *
 * Paise rather than rupee floats because 0.1 has no exact binary
 * representation, so repeated ledger arithmetic on floats drifts and never
 * reconciles against Razorpay to the paisa. Razorpay's API speaks paise too, so
 * this removes a conversion rather than adding one.
 */

/** Convert paise to rupees as a number. For display only — never store this. */
export const paiseToRupees = (paise: number): number => paise / 100;

/** Convert a rupee amount (e.g. from a form field) to paise. */
export const rupeesToPaise = (rupees: number): number => Math.round(rupees * 100);

/**
 * Format paise as a rupee string: 125050 → "₹1,250.50".
 *
 * Whole rupee amounts drop the decimals ("₹1,250") since most print jobs price
 * in whole rupees and the trailing ".00" is noise.
 */
export const formatMoney = (paise: number | undefined | null): string => {
  const value = paiseToRupees(paise ?? 0);
  const hasPaise = (paise ?? 0) % 100 !== 0;
  return `₹${value.toLocaleString('en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
};

/** Format paise always showing two decimals: 125000 → "₹1,250.00". */
export const formatMoneyExact = (paise: number | undefined | null): string =>
  `₹${paiseToRupees(paise ?? 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
