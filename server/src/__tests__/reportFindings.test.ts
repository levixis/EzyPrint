/**
 * Regressions for the findings in the external bug scan that turned out real.
 *
 * Grouped in one file because they share a provenance rather than a subsystem:
 * each is a claim from that report that was checked against the code and held.
 * The report's headline finding — that account deletion cancels paid orders
 * without refunding — did **not** hold, and the first test pins the guard that
 * already covers it so nobody "fixes" it a second time.
 */

import { computeBalanceMovement } from '../services/ledger.service';
import { sanitizeBody, blockPathTraversal } from '../middleware/security';
import { OTP_TTL_MS, OTP_TTL_LABEL } from '../services/otp.service';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('A1 — the deletion guard already covers unfulfilled paid orders', () => {
  test('the paid-but-unprinted check runs before any ledger lookup', () => {
    // The report claimed the guard only blocks orders carrying ledger entries,
    // so a paid PENDING_APPROVAL order with no ORDER_EARNING yet could be
    // cancelled without a refund. It cannot: that count runs first and throws.
    const source = readFileSync(join(__dirname, '../routes/admin.routes.ts'), 'utf8');
    const fn = source.slice(source.indexOf('export async function assertOrdersSafeToDelete'));

    const statusCheck = fn.indexOf("'PENDING_APPROVAL', 'PRINTING', 'READY_FOR_PICKUP'");
    const ledgerCheck = fn.indexOf('ledgerEntry.count');

    expect(statusCheck).toBeGreaterThan(-1);
    expect(ledgerCheck).toBeGreaterThan(-1);
    expect(statusCheck).toBeLessThan(ledgerCheck);
  });
});

describe('B4 — the sanitize bypass is anchored, not a substring', () => {
  const run = (originalUrl: string) => {
    const req: any = { body: { raw: 'a\u0000b' }, params: {}, originalUrl };
    sanitizeBody(req, {} as never, () => { /* next */ });
    return req.body.raw;
  };

  test('the real webhook route keeps its bytes untouched', () => {
    // Sanitising here would alter the payload the HMAC was computed over.
    expect(run('/api/v1/payments/webhook')).toBe('a\u0000b');
  });

  test('a route that merely contains the word does NOT inherit the exemption', () => {
    // `includes('/webhook')` handed this the same pass. It has no HMAC to
    // protect, so it must be cleaned like any other body.
    expect(run('/api/v1/shops/webhook-test')).toBe('ab');
  });

  test('a query string does not defeat the anchor', () => {
    expect(run('/api/v1/payments/webhook?retry=1')).toBe('a\u0000b');
  });
});

describe('B3 — path traversal is caught in any encoding case', () => {
  const blocked = (file: string) => {
    const req: any = { body: {}, params: { file } };
    let passed = false;
    try {
      blockPathTraversal(req, {} as never, () => { passed = true; });
    } catch { /* threw means blocked */ }
    return !passed;
  };

  test('plain, lowercase and uppercase encodings are all rejected', () => {
    // Percent-encoding is case-insensitive per RFC 3986 — all three spell the
    // same sequence, and only the lowercase one was matched.
    expect(blocked('../../etc/passwd')).toBe(true);
    expect(blocked('%2e%2e/etc/passwd')).toBe(true);
    expect(blocked('%2E%2E/etc/passwd')).toBe(true);
    expect(blocked('%2e%2E/etc/passwd')).toBe(true);
  });

  test('an ordinary storage key still passes', () => {
    expect(blocked('orders/1699-abc-thesis.pdf')).toBe(false);
  });
});

describe('B5 — the OTP expiry sentence is derived from the TTL', () => {
  test('the label tracks the constant rather than repeating it', () => {
    expect(OTP_TTL_LABEL).toBe(`${OTP_TTL_MS / 60000} minutes`);
  });

  test('no email copy hardcodes a duration any more', () => {
    // Both codes this app sends come from the same issueOtp, so they share one
    // TTL — and the email stated it in four hardcoded places.
    const email = readFileSync(join(__dirname, '../services/email.service.ts'), 'utf8');
    expect(email).not.toMatch(/\b\d+ minutes\b/);
  });
});

describe('B7 — a ledger entry must move a non-zero amount', () => {
  test('a zero amount moves nothing, which is why it is now refused', () => {
    const shop = { pendingBalance: 1000, ledgerBalance: 0, debtAmount: 0 };
    expect(computeBalanceMovement('ORDER_EARNING', 0, shop)).toEqual({
      clearing: 0, available: 0, debt: 0,
    });
  });
});
