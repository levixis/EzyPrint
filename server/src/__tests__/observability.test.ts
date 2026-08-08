/**
 * Unit Tests — error fingerprinting and redaction.
 *
 * Two properties carry the whole aggregation scheme, and both fail silently if
 * they are wrong:
 *
 *  1. Two occurrences of the same defect must land on the same fingerprint.
 *     If they do not, a bug hitting 300 students files 300 separate rows, the
 *     `count` that alerting reads never rises above 1, and the dashboard shows
 *     a wall of singletons with no signal in it.
 *
 *  2. Two genuinely different defects must NOT collide. A fingerprint that
 *     over-normalizes merges unrelated failures, and the second one to appear
 *     is silently swallowed into the first's row — a bug that is invisible
 *     precisely because monitoring claims to have seen it.
 *
 * Plus redaction: system_events is rendered in the admin dashboard, so anything
 * stored here is effectively displayed.
 */

jest.mock('../utils/prisma', () => ({ prisma: {} }));

import { __testing } from '../services/observability.service';

const { normalize, fingerprint, sanitizeContext } = __testing;

describe('normalize', () => {
  test('strips cuids, so the same failure on different records agrees', () => {
    const a = normalize('Order cm3x9a7b2c4d6e8f0g1h2i3j failed to reprice');
    const b = normalize('Order cm7k2b9d4e6f8g0h2i4j6k8l failed to reprice');
    expect(a).toBe(b);
  });

  test('strips Razorpay ids', () => {
    const a = normalize('Capture mismatch for order_PabcXYZ123');
    const b = normalize('Capture mismatch for order_QdefUVW456');
    expect(a).toBe(b);
  });

  test('strips amounts and counts', () => {
    const a = normalize('Refund of 4900 exceeded balance by 200');
    const b = normalize('Refund of 15000 exceeded balance by 7350');
    expect(a).toBe(b);
  });

  test('strips email addresses, which also keeps them out of the row', () => {
    const normalized = normalize('No account for student@college.edu');
    expect(normalized).not.toContain('student@college.edu');
    expect(normalized).toContain('<email>');
  });

  test('strips timestamps', () => {
    const a = normalize('Settlement due at 2026-08-04T06:00:00.000Z never ran');
    const b = normalize('Settlement due at 2026-08-05T06:00:00.000Z never ran');
    expect(a).toBe(b);
  });
});

describe('fingerprint', () => {
  test('the same defect from the same source is one fingerprint', () => {
    expect(fingerprint('http', 'Order cm3x9a7b2c4d6e8f0g1h2i3j not found')).toBe(
      fingerprint('http', 'Order cm7k2b9d4e6f8g0h2i4j6k8l not found')
    );
  });

  test('different messages stay distinct', () => {
    expect(fingerprint('http', 'Order not found')).not.toBe(
      fingerprint('http', 'Shop is archived')
    );
  });

  test('the same message from different subsystems stays distinct', () => {
    // A timeout in the payment path and a timeout in the upload path are two
    // problems with two fixes; merging them would hide whichever arrives second.
    expect(fingerprint('payment', 'Request timed out')).not.toBe(
      fingerprint('upload', 'Request timed out')
    );
  });

  test('is stable across calls — the dedupe key cannot drift between restarts', () => {
    expect(fingerprint('http', 'Connection reset')).toBe(fingerprint('http', 'Connection reset'));
  });
});

describe('sanitizeContext', () => {
  test('redacts credential-bearing keys', () => {
    const clean = sanitizeContext({
      path: '/api/v1/auth/login',
      password: 'hunter2',
      refreshToken: 'eyJhbGciOi...',
      otp: '482913',
      authorization: 'Bearer abc',
    }) as Record<string, unknown>;

    expect(clean.path).toBe('/api/v1/auth/login');
    expect(clean.password).toBe('<redacted>');
    expect(clean.refreshToken).toBe('<redacted>');
    expect(clean.otp).toBe('<redacted>');
    expect(clean.authorization).toBe('<redacted>');
  });

  test('redacts nested secrets, not only top-level ones', () => {
    const clean = sanitizeContext({
      request: { body: { token: 'secret-value' } },
    }) as { request: { body: { token: string } } };

    expect(clean.request.body.token).toBe('<redacted>');
  });

  test('caps recursion so a cyclic-looking structure cannot hang the reporter', () => {
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let i = 0; i < 12; i++) deep = { nested: deep };

    expect(() => sanitizeContext(deep)).not.toThrow();
    expect(JSON.stringify(sanitizeContext(deep))).toContain('<truncated>');
  });

  test('caps array length, so one bad request cannot write a megabyte row', () => {
    const clean = sanitizeContext(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
    expect(clean.length).toBe(20);
  });

  test('truncates long strings', () => {
    const clean = sanitizeContext({ blob: 'x'.repeat(5000) }) as { blob: string };
    expect(clean.blob.length).toBe(1000);
  });
});
