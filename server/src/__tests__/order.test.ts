/**
 * Unit Tests — Order Pricing & FSM Validation
 *
 * These test the PURE BUSINESS LOGIC without touching the database.
 * We import the pricing functions and state machine rules directly.
 */

import { calculateOrderPrice, calculateBaseFee } from '../services/pricing.service';

// Pricing is imported from the real module rather than reimplemented here. The
// previous copy of the formula in this file drifted from both the service and
// the frontend without any test failing.

type TestFile = {
  pages: number;
  copies: number;
  doubleSided: boolean;
  color: 'BLACK_WHITE' | 'COLOR';
};

/** Price a single file at the given rates. All amounts are paise. */
function price(file: TestFile, bwPerPage: number, colorPerPage: number) {
  return calculateOrderPrice(
    [{ pageCount: file.pages, color: file.color, copies: file.copies, doubleSided: file.doubleSided }],
    { bwPerPage, colorPerPage }
  );
}

/**
 * Order FSM: valid transitions
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  PENDING_PAYMENT: ['PENDING_APPROVAL', 'CANCELLED', 'PAYMENT_FAILED'],
  PENDING_APPROVAL: ['PRINTING', 'CANCELLED'],
  PRINTING: ['READY_FOR_PICKUP', 'CANCELLED'],
  READY_FOR_PICKUP: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  PAYMENT_FAILED: ['PENDING_PAYMENT'],
  REFUNDED: [],
};

function isValidTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ────────────────────────────────────────────────────────────
// PRICING TESTS
// ────────────────────────────────────────────────────────────

describe('Order Pricing Logic (paise)', () => {
  // ₹2/page B&W, ₹5/page colour.
  const BW = 200;
  const COLOR = 500;

  test('basic B&W single-sided order', () => {
    const r = price({ pages: 5, copies: 1, doubleSided: false, color: 'BLACK_WHITE' }, BW, COLOR);
    expect(r.pageCost).toBe(1000);   // 5 * 1 * ₹2
    expect(r.baseFee).toBe(300);     // ₹10 page cost falls in the ₹5–₹30 band
    expect(r.totalPrice).toBe(1300);
  });

  test('double-sided bills sheets at 1.5x rather than per page', () => {
    const r = price({ pages: 20, copies: 1, doubleSided: true, color: 'BLACK_WHITE' }, BW, COLOR);
    // 10 sheets at ₹3 (1.5 x ₹2) = ₹30
    expect(r.pageCost).toBe(3000);
    expect(r.baseFee).toBe(300);
    expect(r.totalPrice).toBe(3300);
  });

  test('odd page count double-sided bills the trailing page single-sided', () => {
    const r = price({ pages: 7, copies: 1, doubleSided: true, color: 'BLACK_WHITE' }, BW, COLOR);
    // 3 full sheets at ₹3 + 1 page at ₹2 = ₹11
    expect(r.pageCost).toBe(1100);
  });

  test('colour pricing uses colorPerPage', () => {
    const r = price({ pages: 10, copies: 2, doubleSided: false, color: 'COLOR' }, BW, COLOR);
    expect(r.pageCost).toBe(10000);  // 10 * 2 * ₹5
    expect(r.baseFee).toBe(500);     // over ₹70
    expect(r.totalPrice).toBe(10500);
  });

  test('multiple copies multiply', () => {
    const r = price({ pages: 3, copies: 5, doubleSided: false, color: 'BLACK_WHITE' }, BW, COLOR);
    expect(r.pageCost).toBe(3000);   // 3 * 5 * ₹2
    expect(r.totalPrice).toBe(3300);
  });

  test('one base fee covers a multi-file order', () => {
    const r = calculateOrderPrice(
      [
        { pageCount: 10, color: 'BLACK_WHITE', copies: 1, doubleSided: false },
        { pageCount: 10, color: 'COLOR', copies: 1, doubleSided: false },
      ],
      { bwPerPage: BW, colorPerPage: COLOR }
    );
    expect(r.pageCost).toBe(7000);   // ₹20 + ₹50
    expect(r.baseFee).toBe(400);     // single fee, not one per file
  });

  test('a Student Pass waives the base fee at or below ₹30', () => {
    const files = [{ pageCount: 10, color: 'BLACK_WHITE' as const, copies: 1, doubleSided: false }];
    const rates = { bwPerPage: BW, colorPerPage: COLOR };

    expect(calculateOrderPrice(files, rates, false).baseFee).toBe(300);
    expect(calculateOrderPrice(files, rates, true).baseFee).toBe(0);
  });

  test('a Student Pass does not waive the fee above ₹30', () => {
    const files = [{ pageCount: 20, color: 'COLOR' as const, copies: 1, doubleSided: false }];
    const withPass = calculateOrderPrice(files, { bwPerPage: BW, colorPerPage: COLOR }, true);
    expect(withPass.pageCost).toBe(10000);  // ₹100, above the waiver ceiling
    expect(withPass.baseFee).toBe(500);
  });

  test('base fee bands', () => {
    expect(calculateBaseFee(0)).toBe(0);
    expect(calculateBaseFee(500)).toBe(200);    // ₹5
    expect(calculateBaseFee(501)).toBe(300);
    expect(calculateBaseFee(3000)).toBe(300);   // ₹30
    expect(calculateBaseFee(3001)).toBe(400);
    expect(calculateBaseFee(7000)).toBe(400);   // ₹70
    expect(calculateBaseFee(7001)).toBe(500);
  });

  test('prices are always whole paise', () => {
    // ₹1.25/page double-sided puts the 1.5x multiplier on a half-paisa.
    const r = price({ pages: 3, copies: 1, doubleSided: true, color: 'BLACK_WHITE' }, 125, COLOR);
    expect(Number.isInteger(r.pageCost)).toBe(true);
    expect(Number.isInteger(r.totalPrice)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// FSM TRANSITION TESTS
// ────────────────────────────────────────────────────────────

describe('Order State Machine (FSM)', () => {
  describe('valid transitions', () => {
    const validCases = [
      ['PENDING_PAYMENT', 'PENDING_APPROVAL'],
      ['PENDING_PAYMENT', 'CANCELLED'],
      ['PENDING_PAYMENT', 'PAYMENT_FAILED'],
      ['PENDING_APPROVAL', 'PRINTING'],
      ['PENDING_APPROVAL', 'CANCELLED'],
      ['PRINTING', 'READY_FOR_PICKUP'],
      ['PRINTING', 'CANCELLED'],
      ['READY_FOR_PICKUP', 'COMPLETED'],
      ['READY_FOR_PICKUP', 'CANCELLED'],
      ['PAYMENT_FAILED', 'PENDING_PAYMENT'],
    ];

    test.each(validCases)('%s → %s should be valid', (from, to) => {
      expect(isValidTransition(from, to)).toBe(true);
    });
  });

  describe('invalid transitions', () => {
    const invalidCases = [
      ['PENDING_PAYMENT', 'PRINTING'],      // Can't skip PENDING_APPROVAL
      ['PENDING_PAYMENT', 'COMPLETED'],      // Can't skip to end
      ['PRINTING', 'COMPLETED'],             // Must go through READY_FOR_PICKUP
      ['COMPLETED', 'PRINTING'],             // Terminal state, no going back
      ['COMPLETED', 'CANCELLED'],            // Can't cancel completed
      ['CANCELLED', 'PRINTING'],             // Terminal state
      ['REFUNDED', 'PENDING_PAYMENT'],       // Terminal state
      ['READY_FOR_PICKUP', 'PRINTING'],      // Can't go back
    ];

    test.each(invalidCases)('%s → %s should be INVALID', (from, to) => {
      expect(isValidTransition(from, to)).toBe(false);
    });
  });

  describe('terminal states have no valid transitions', () => {
    const terminalStates = ['COMPLETED', 'CANCELLED', 'REFUNDED'];

    test.each(terminalStates)('%s is a terminal state', (state) => {
      expect(VALID_TRANSITIONS[state]).toHaveLength(0);
    });
  });
});
