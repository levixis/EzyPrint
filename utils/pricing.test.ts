import { describe, test, expect } from 'vitest';
import { calculateMultiFileOrderPrice, calculateBaseFee } from './pricing';
import { calculateOrderPrice as serverCalculateOrderPrice, calculateBaseFee as serverCalculateBaseFee } from '../server/src/services/pricing.service';

/**
 * The frontend and the server both price orders, and they must agree.
 *
 * `pricing.service.ts` carries the instruction "the frontend mirrors this
 * logic in utils/pricing.ts and the two MUST agree — if you change a rule
 * here, change it there." Nothing enforced it, so the only thing standing
 * between a quoted price and the amount actually charged was somebody
 * remembering to edit both files.
 *
 * This imports both implementations and runs them against the same inputs.
 * It fails the moment one drifts, which is the point — a student seeing one
 * figure and being charged another is the worst version of this bug, and it
 * would otherwise surface as a support ticket rather than a red test.
 */

const rates = { bwPerPage: 200, colorPerPage: 500 };

/** The server takes a file list; the client takes print options. */
const bothPrice = (
  file: { pageCount: number; color: 'BLACK_WHITE' | 'COLOR'; copies: number; doubleSided: boolean },
  hasPass = false
) => {
  const server = serverCalculateOrderPrice([file], rates, hasPass);
  const client = calculateMultiFileOrderPrice(
    [{ pageCount: file.pageCount, color: file.color as never, copies: file.copies, doubleSided: file.doubleSided }],
    rates,
    hasPass
  );
  return { server, client };
};

describe('Client and server price identically', () => {
  const cases: Array<[string, Parameters<typeof bothPrice>[0]]> = [
    ['a single black-and-white page', { pageCount: 1, color: 'BLACK_WHITE', copies: 1, doubleSided: false }],
    ['a colour page', { pageCount: 1, color: 'COLOR', copies: 1, doubleSided: false }],
    ['many pages', { pageCount: 200, color: 'BLACK_WHITE', copies: 1, doubleSided: false }],
    ['multiple copies', { pageCount: 10, color: 'BLACK_WHITE', copies: 3, doubleSided: false }],
    // The 1.5x sheet multiplier is the fiddliest rule and the likeliest to drift.
    ['double-sided, even pages', { pageCount: 10, color: 'BLACK_WHITE', copies: 1, doubleSided: true }],
    ['double-sided, odd pages', { pageCount: 11, color: 'BLACK_WHITE', copies: 1, doubleSided: true }],
    ['double-sided, single page', { pageCount: 1, color: 'BLACK_WHITE', copies: 1, doubleSided: true }],
    ['double-sided colour, many copies', { pageCount: 25, color: 'COLOR', copies: 4, doubleSided: true }],
  ];

  for (const [name, file] of cases) {
    test(name, () => {
      const { server, client } = bothPrice(file);
      expect(client.pageCost).toBe(server.pageCost);
      expect(client.baseFee).toBe(server.baseFee);
      expect(client.totalPrice).toBe(server.totalPrice);
    });
  }

  test('the Student Pass waiver applies on both sides', () => {
    // Under the ₹30 ceiling the base fee is waived.
    const small = bothPrice({ pageCount: 5, color: 'BLACK_WHITE', copies: 1, doubleSided: false }, true);
    expect(small.client.baseFee).toBe(0);
    expect(small.client.totalPrice).toBe(small.server.totalPrice);
  });

  test('the waiver stops applying above the ceiling on both sides', () => {
    const large = bothPrice({ pageCount: 100, color: 'COLOR', copies: 1, doubleSided: false }, true);
    expect(large.client.baseFee).toBe(large.server.baseFee);
    expect(large.client.baseFee).toBeGreaterThan(0);
    expect(large.client.totalPrice).toBe(large.server.totalPrice);
  });
});

describe('Base fee tiers match', () => {
  test('every boundary agrees', () => {
    // Boundaries are where tiered pricing diverges when only one side is edited.
    for (const pageCost of [0, 1, 999, 1000, 1001, 2999, 3000, 3001, 9999, 10000, 50000]) {
      expect(calculateBaseFee(pageCost)).toBe(serverCalculateBaseFee(pageCost));
    }
  });
});

describe('Prices are whole paise', () => {
  test('the 1.5x double-sided multiplier never yields a fraction of a paisa', () => {
    // An odd rate times 1.5 lands on a half-paisa, and paise are the smallest
    // unit that can actually be charged.
    const odd = { bwPerPage: 333, colorPerPage: 777 };
    const result = serverCalculateOrderPrice(
      [{ pageCount: 7, color: 'BLACK_WHITE', copies: 3, doubleSided: true }],
      odd,
      false
    );
    expect(Number.isInteger(result.pageCost)).toBe(true);
    expect(Number.isInteger(result.totalPrice)).toBe(true);
  });
});
