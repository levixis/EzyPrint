/**
 * How the app-wide limiter identifies a caller, and what it refuses to touch.
 *
 * Two production failures live here. Render's liveness probe was being counted
 * against a shared bucket and started receiving our own 429, which the platform
 * read as the service being unhealthy — so the rate limiter was restarting the
 * instance in a loop. And the bucket was keyed on the client address, which for
 * a campus product means every student behind one institutional NAT address
 * shares a hundred requests per fifteen minutes between them.
 *
 * The limiters themselves are express-rate-limit's; what is ours, and what is
 * worth pinning, is the key and the skip.
 */

import type { Request } from 'express';

// The key and skip functions are exported and tested directly:
// express-rate-limit keeps its options private, so reaching into the returned
// middleware tests nothing.
import { tokenOrClientKey, userOrClientKey, isHealthCheckPath } from '../middleware/rateLimiter';

const req = (over: Partial<Request> = {}): Request =>
  ({ ip: '10.0.0.1', path: '/v1/orders', headers: {}, ...over }) as Request;

describe('Health checks are never rate limited', () => {
  test('the liveness path is skipped', () => {
    // Render probes far more often than once every nine seconds, so counting
    // the probe exhausted the window and the 429 read as an unhealthy service.
    expect(isHealthCheckPath('/v1/health')).toBe(true);
  });

  test('sub-paths under health are skipped too', () => {
    expect(isHealthCheckPath('/v1/health/db')).toBe(true);
  });

  test('ordinary API paths are still counted', () => {
    expect(isHealthCheckPath('/v1/orders')).toBe(false);
    expect(isHealthCheckPath('/v1/payouts')).toBe(false);
  });

  test('a path merely containing "health" is not exempt', () => {
    // Guards against a `.includes()` style check letting real endpoints through.
    expect(isHealthCheckPath('/v1/shops/health-clinic')).toBe(false);
  });
});

describe('Two students on the same campus wifi do not share a budget', () => {
  const SAME_IP = { ip: '103.21.244.9' };

  test('different sessions on one address get different keys', () => {
    const a = tokenOrClientKey(req({ ...SAME_IP, headers: { authorization: 'Bearer token-aaa' } }));
    const b = tokenOrClientKey(req({ ...SAME_IP, headers: { authorization: 'Bearer token-bbb' } }));

    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  test('the same session is one key across requests', () => {
    const first = tokenOrClientKey(req({ ip: '1.1.1.1', headers: { authorization: 'Bearer token-aaa' } }));
    const second = tokenOrClientKey(req({ ip: '2.2.2.2', headers: { authorization: 'Bearer token-aaa' } }));

    expect(first).toBe(second);
  });

  test('the key never contains the token itself', () => {
    // Bucket keys reach logs and memory dumps; a raw JWT must not.
    const key = tokenOrClientKey(req({ headers: { authorization: 'Bearer super.secret.jwt' } })) ?? '';

    expect(key).not.toContain('super.secret.jwt');
    expect(key).toMatch(/^tok:[0-9a-f]{32}$/);
  });

  test('an anonymous caller still falls back to their address', () => {
    expect(tokenOrClientKey(req({ ip: '203.0.113.5' }))).toBe('ip:203.0.113.5');
  });

  test('a malformed Authorization header falls back rather than keying on junk', () => {
    expect(tokenOrClientKey(req({ ip: '203.0.113.5', headers: { authorization: 'Bearer ' } })))
      .toBe('ip:203.0.113.5');
    expect(tokenOrClientKey(req({ ip: '203.0.113.5', headers: { authorization: 'Basic abc' } })))
      .toBe('ip:203.0.113.5');
  });

  test('IPv6 callers are still collapsed to a /64', () => {
    // A single customer allocation holds 2^64 addresses; keying on the full
    // address lets one caller sidestep the limit by incrementing it.
    const key = tokenOrClientKey(req({ ip: '2401:4900:1c80:aaaa:bbbb:cccc:dddd:eeee' }));
    expect(key).toBe('ip:2401:4900:1c80:aaaa::/64');
  });
});

describe('Per-user limiters are unchanged', () => {
  test('sensitiveLimiter still keys on the authenticated user', () => {
    // It is mounted after `authenticate`, so `req.user` genuinely exists there
    // — which is exactly why the app-wide limiter could not use the same key.
    const withUser = { ...req(), user: { userId: 'user_1' } } as unknown as Request;
    expect(userOrClientKey(withUser)).toBe('user:user_1');
  });
});
