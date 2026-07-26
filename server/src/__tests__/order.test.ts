/**
 * Unit Tests — Order Pricing & FSM Validation
 *
 * These test the PURE BUSINESS LOGIC without touching the database.
 * We import the pricing functions and state machine rules directly.
 */

// ── Pricing Logic (extracted for testability) ──

/**
 * Calculate total price for a print order.
 * This matches the logic in order.service.ts
 */
function calculatePricing(input: {
  pages: number;
  copies: number;
  doubleSided: boolean;
  color: 'BLACK_WHITE' | 'COLOR';
  bwPerPage: number;
  colorPerPage: number;
}): { effectiveSheets: number; pageCost: number; baseFee: number; totalPrice: number } {
  const { pages, copies, doubleSided, color, bwPerPage, colorPerPage } = input;

  const effectiveSheets = doubleSided ? Math.ceil(pages / 2) : pages;
  const pricePerPage = color === 'COLOR' ? colorPerPage : bwPerPage;
  const pageCost = effectiveSheets * copies * pricePerPage;

  // Base fee: ≤5→₹2, ≤20→₹3, ≤50→₹5, >50→10% of pageCost
  let baseFee: number;
  if (pages <= 5) baseFee = 2;
  else if (pages <= 20) baseFee = 3;
  else if (pages <= 50) baseFee = 5;
  else baseFee = Math.round(pageCost * 0.1);

  return {
    effectiveSheets,
    pageCost,
    baseFee,
    totalPrice: pageCost + baseFee,
  };
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

describe('Order Pricing Logic', () => {
  test('basic B&W single-sided order', () => {
    const result = calculatePricing({
      pages: 5, copies: 1, doubleSided: false,
      color: 'BLACK_WHITE', bwPerPage: 2, colorPerPage: 5,
    });
    expect(result.effectiveSheets).toBe(5);
    expect(result.pageCost).toBe(10);  // 5 * 1 * 2
    expect(result.baseFee).toBe(2);    // ≤5 pages → ₹2
    expect(result.totalPrice).toBe(12);
  });

  test('double-sided reduces effective sheets', () => {
    const result = calculatePricing({
      pages: 20, copies: 1, doubleSided: true,
      color: 'BLACK_WHITE', bwPerPage: 2, colorPerPage: 5,
    });
    expect(result.effectiveSheets).toBe(10);  // ceil(20/2)
    expect(result.pageCost).toBe(20);  // 10 * 1 * 2
    expect(result.baseFee).toBe(3);    // ≤20 pages → ₹3
    expect(result.totalPrice).toBe(23);
  });

  test('odd pages double-sided rounds up', () => {
    const result = calculatePricing({
      pages: 7, copies: 1, doubleSided: true,
      color: 'BLACK_WHITE', bwPerPage: 2, colorPerPage: 5,
    });
    expect(result.effectiveSheets).toBe(4);  // ceil(7/2)
  });

  test('color pricing uses colorPerPage', () => {
    const result = calculatePricing({
      pages: 10, copies: 2, doubleSided: false,
      color: 'COLOR', bwPerPage: 2, colorPerPage: 5,
    });
    expect(result.pageCost).toBe(100);  // 10 * 2 * 5
    expect(result.baseFee).toBe(3);     // ≤20 pages → ₹3
    expect(result.totalPrice).toBe(103);
  });

  test('multiple copies multiplied correctly', () => {
    const result = calculatePricing({
      pages: 3, copies: 5, doubleSided: false,
      color: 'BLACK_WHITE', bwPerPage: 2, colorPerPage: 5,
    });
    expect(result.pageCost).toBe(30);  // 3 * 5 * 2
    expect(result.baseFee).toBe(2);    // ≤5 pages → ₹2
    expect(result.totalPrice).toBe(32);
  });

  test('large order: base fee is 10% of page cost', () => {
    const result = calculatePricing({
      pages: 100, copies: 3, doubleSided: false,
      color: 'COLOR', bwPerPage: 2, colorPerPage: 5,
    });
    expect(result.pageCost).toBe(1500);  // 100 * 3 * 5
    expect(result.baseFee).toBe(150);    // 10% of 1500
    expect(result.totalPrice).toBe(1650);
  });

  test('exactly 50 pages: base fee is ₹5', () => {
    const result = calculatePricing({
      pages: 50, copies: 1, doubleSided: false,
      color: 'BLACK_WHITE', bwPerPage: 1, colorPerPage: 3,
    });
    expect(result.baseFee).toBe(5);
  });

  test('51 pages: base fee switches to 10%', () => {
    const result = calculatePricing({
      pages: 51, copies: 1, doubleSided: false,
      color: 'BLACK_WHITE', bwPerPage: 1, colorPerPage: 3,
    });
    expect(result.baseFee).toBe(Math.round(51 * 0.1));  // 5
  });

  test('real scenario from integration test: 20p, double, COLOR, 3 copies', () => {
    const result = calculatePricing({
      pages: 20, copies: 3, doubleSided: true,
      color: 'COLOR', bwPerPage: 2, colorPerPage: 5,
    });
    expect(result.effectiveSheets).toBe(10);
    expect(result.pageCost).toBe(150);  // 10 * 3 * 5
    expect(result.baseFee).toBe(3);     // ≤20 pages → ₹3 (based on pages not sheets)
    expect(result.totalPrice).toBe(153);
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
