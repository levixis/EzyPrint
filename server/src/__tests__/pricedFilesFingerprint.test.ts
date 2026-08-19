/**
 * The amount check cannot see a file swap, and this is what can.
 *
 * `payment.captured` compares `payment.amount` to `order.totalPrice`. Both are
 * frozen when the Razorpay order is minted, so they agree with each other no
 * matter what happened to the files afterwards — swap a one-page document for a
 * two-hundred-page one and neither figure moves. The upload guard stops that at
 * the door; this is the proof at the moment money is confirmed, for anything
 * that reaches the payment boundary by a route nobody anticipated.
 *
 * Deliberately hashes the *file set*, not a recomputed price: re-pricing at
 * capture would use the shop's current rates, and shops change rates
 * legitimately between checkout and capture, so an ordinary price update would
 * read as tampering.
 */

const mockOrderFileFindMany = jest.fn();

const client = { orderFile: { findMany: mockOrderFileFindMany } } as never;

import { fingerprintPricedFiles, pricedFilesUnchanged } from '../services/order.service';

const oneSmallFile = [{
  id: 'f_1',
  verifiedPageCount: 1,
  pageCount: 1,
  color: 'BLACK_WHITE',
  copies: 1,
  doubleSided: false,
  fileStoragePath: 'orders/1699-one-page.pdf',
}];

beforeEach(() => {
  jest.clearAllMocks();
  mockOrderFileFindMany.mockResolvedValue(oneSmallFile);
});

describe('fingerprintPricedFiles', () => {
  test('the same file set always hashes the same way', async () => {
    const a = await fingerprintPricedFiles(client, 'order_1');
    const b = await fingerprintPricedFiles(client, 'order_1');

    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  test('reads the files in id order, so row order cannot change the hash', async () => {
    await fingerprintPricedFiles(client, 'order_1');

    expect(mockOrderFileFindMany.mock.calls[0][0].orderBy).toEqual({ id: 'asc' });
  });

  test.each([
    ['page count', { verifiedPageCount: 200 }],
    ['colour', { color: 'COLOR' }],
    ['copies', { copies: 5 }],
    ['double-sided', { doubleSided: true }],
    ['the stored document itself', { fileStoragePath: 'orders/1699-two-hundred-pages.pdf' }],
  ])('a change to %s changes the hash', async (_label, change) => {
    const before = await fingerprintPricedFiles(client, 'order_1');
    mockOrderFileFindMany.mockResolvedValue([{ ...oneSmallFile[0], ...change }]);
    const after = await fingerprintPricedFiles(client, 'order_1');

    expect(after).not.toBe(before);
  });

  test('falls back to the claimed page count when nothing was verified', async () => {
    // The same fallback `repriceFromVerifiedPages` makes, so the hash describes
    // exactly the inputs that produced the price.
    mockOrderFileFindMany.mockResolvedValue([
      { ...oneSmallFile[0], verifiedPageCount: null, pageCount: 7 },
    ]);
    const withNull = await fingerprintPricedFiles(client, 'order_1');

    mockOrderFileFindMany.mockResolvedValue([
      { ...oneSmallFile[0], verifiedPageCount: 7, pageCount: 7 },
    ]);
    const withVerified = await fingerprintPricedFiles(client, 'order_1');

    expect(withNull).toBe(withVerified);
  });

  test('adding a second file changes the hash', async () => {
    const before = await fingerprintPricedFiles(client, 'order_1');
    mockOrderFileFindMany.mockResolvedValue([
      ...oneSmallFile,
      { ...oneSmallFile[0], id: 'f_2', fileStoragePath: 'orders/1699-extra.pdf' },
    ]);

    expect(await fingerprintPricedFiles(client, 'order_1')).not.toBe(before);
  });
});

describe('FINGERPRINT_VERIFY parsing', () => {
  /**
   * The switch exists so a check that can refuse *paid* orders can be turned
   * off without a redeploy. An inverted or fragile parse is therefore the one
   * bug that would defeat its whole purpose — shipping "log" and getting
   * enforcement is exactly the outcome the flag is meant to make impossible.
   */
  const loadEnv = (value: string | undefined) => {
    let parsed: string | undefined;
    jest.isolateModules(() => {
      const previous = process.env.FINGERPRINT_VERIFY;
      if (value === undefined) delete process.env.FINGERPRINT_VERIFY;
      else process.env.FINGERPRINT_VERIFY = value;

      parsed = (require('../config/env') as { env: { FINGERPRINT_VERIFY: string } }).env
        .FINGERPRINT_VERIFY;

      if (previous === undefined) delete process.env.FINGERPRINT_VERIFY;
      else process.env.FINGERPRINT_VERIFY = previous;
    });
    return parsed;
  };

  test('defaults to log when unset — an absent variable must never enforce', () => {
    expect(loadEnv(undefined)).toBe('log');
  });

  test('only the exact string "enforce" enables enforcement', () => {
    expect(loadEnv('enforce')).toBe('enforce');
  });

  test.each(['Enforce', 'ENFORCE', 'true', '1', 'yes', 'enforce ', '', 'log'])(
    'falls back to log for %p',
    (value) => {
      // Anything ambiguous resolves to the safe side. A typo in an env var
      // must not silently start refusing customers' paid orders.
      expect(loadEnv(value)).toBe('log');
    }
  );
});

describe('pricedFilesUnchanged', () => {
  test('passes when the files still match what was priced', async () => {
    const fingerprint = await fingerprintPricedFiles(client, 'order_1');

    await expect(
      pricedFilesUnchanged(client, { id: 'order_1', pricedFilesFingerprint: fingerprint })
    ).resolves.toBe(true);
  });

  test('fails when the document was swapped after the price was set', async () => {
    // The exact exploit: one page priced, two hundred pages printed.
    const atCheckout = await fingerprintPricedFiles(client, 'order_1');
    mockOrderFileFindMany.mockResolvedValue([
      { ...oneSmallFile[0], verifiedPageCount: 200, fileStoragePath: 'orders/1699-swapped.pdf' },
    ]);

    await expect(
      pricedFilesUnchanged(client, { id: 'order_1', pricedFilesFingerprint: atCheckout })
    ).resolves.toBe(false);
  });

  test('a null fingerprint passes, because there is nothing to compare', async () => {
    // Orders priced before this column existed. Refusing them would strand
    // perfectly legitimate payments; they are covered by the upload guard.
    await expect(
      pricedFilesUnchanged(client, { id: 'order_1', pricedFilesFingerprint: null })
    ).resolves.toBe(true);

    // And it must not even bother reading the files.
    expect(mockOrderFileFindMany).not.toHaveBeenCalled();
  });
});
