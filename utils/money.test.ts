import { describe, test, expect } from 'vitest';
import { formatMoney, formatMoneyExact, paiseToRupees, rupeesToPaise } from './money';

/**
 * Every monetary value crossing the API is an integer number of paise. Rupees
 * exist only at the display boundary.
 *
 * Interpolating a paise value straight into a string is how a ₹5.00 order
 * announced itself to a student as "₹500", and how a ₹500 payout request would
 * have read "₹50000.00". Both shipped. These pin the boundary.
 */

describe('formatMoney', () => {
  test('the order that told a student ₹5.00 was ₹500', () => {
    expect(formatMoney(500)).toBe('₹5');
  });

  test('drops decimals on whole rupees and keeps them otherwise', () => {
    expect(formatMoney(30000)).toBe('₹300');
    expect(formatMoney(1250)).toBe('₹12.50');
  });

  test('groups in the Indian system, not thousands', () => {
    // 125050 paise is ₹1,250.50 — not ₹1,250.50 formatted as 1,250 either way,
    // but the grouping diverges above a lakh.
    expect(formatMoney(12505000)).toBe('₹1,25,050');
  });

  test('null and undefined render as zero rather than "₹NaN"', () => {
    expect(formatMoney(null)).toBe('₹0');
    expect(formatMoney(undefined)).toBe('₹0');
  });

  test('the Student Pass price', () => {
    expect(formatMoney(4900)).toBe('₹49');
  });
});

describe('formatMoneyExact', () => {
  test('always shows two decimals, for invoices and ledgers', () => {
    expect(formatMoneyExact(30000)).toBe('₹300.00');
    expect(formatMoneyExact(1250)).toBe('₹12.50');
  });
});

describe('paise ↔ rupees', () => {
  test('a rupee amount typed by a human becomes exact paise', () => {
    expect(rupeesToPaise(12.5)).toBe(1250);
    expect(rupeesToPaise(0.1)).toBe(10);
  });

  test('rounds rather than truncating, so ₹12.505 does not lose a paisa downward', () => {
    expect(rupeesToPaise(12.505)).toBe(1251);
  });

  test('round-trips without float drift', () => {
    // The reason paise exist: 0.1 + 0.2 !== 0.3 in binary floating point, so
    // repeated rupee arithmetic never reconciles against Razorpay to the paisa.
    for (const rupees of [0.1, 0.2, 12.5, 99.99, 1250.05]) {
      expect(paiseToRupees(rupeesToPaise(rupees))).toBeCloseTo(rupees, 2);
    }
  });

  test('accumulating paise stays exact where accumulating rupees would not', () => {
    let paise = 0;
    for (let i = 0; i < 10; i++) paise += 10; // ₹0.10 ten times
    expect(paise).toBe(100);
    expect(formatMoney(paise)).toBe('₹1');

    let rupees = 0;
    for (let i = 0; i < 10; i++) rupees += 0.1;
    expect(rupees).not.toBe(1); // 0.9999999999999999
  });
});
