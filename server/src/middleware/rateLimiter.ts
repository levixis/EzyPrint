import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env';

/**
 * Rate limiters.
 *
 * Keying note: express-rate-limit defaults to `req.ip`, which behind a managed
 * proxy (Railway, Vercel) resolves to the edge connection unless `trust proxy`
 * is set — see `app.set('trust proxy', ...)` in index.ts. Without that, every
 * client shares one bucket and 20 bad login attempts lock out the entire user
 * base. `trust proxy` makes `req.ip` the real client address again.
 *
 * IP alone is still the wrong key for credential attacks, which distribute
 * across many addresses while targeting one account. Where an account
 * identifier is available, limiters key on it as well.
 */

const shared = {
  standardHeaders: true as const,  // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false as const,   // Disable the `X-RateLimit-*` headers
};

/**
 * Client key, collapsed to a /64 for IPv6.
 *
 * A single IPv6 customer allocation contains 2^64 addresses, so keying on the
 * full address lets an attacker sidestep any limit by incrementing it. IPv4
 * addresses are used as-is.
 */
function clientKey(req: Request): string {
  const ip = req.ip ?? '';
  if (!ip.includes(':')) return ip;

  // Normalise to the first four hextets (the /64 network prefix).
  const withoutZone = ip.split('%')[0] ?? ip;
  const expanded = withoutZone.startsWith('::ffff:') ? withoutZone.slice(7) : withoutZone;
  if (!expanded.includes(':')) return expanded; // IPv4-mapped

  const [head] = expanded.split('::');
  const hextets = (head ?? '').split(':').filter(Boolean).slice(0, 4);
  return `${hextets.join(':')}::/64`;
}

/** Key on the authenticated user when there is one, otherwise the client address. */
function userOrClientKey(req: Request): string {
  const userId = (req as Request & { user?: { userId?: string } }).user?.userId;
  return userId ? `user:${userId}` : `ip:${clientKey(req)}`;
}

/**
 * General API rate limiter — 100 requests per 15 minutes.
 * Protects against abuse without affecting normal users.
 */
export const generalLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  max: env.isDev ? 1000 : 100,
  message: {
    success: false,
    message: 'Too many requests. Please try again after 15 minutes.',
  },
});

/**
 * Auth endpoints — 20 attempts per 15 minutes.
 *
 * Keyed on the target account as well as the caller's address, so an attacker
 * spreading attempts across many IPs still exhausts the budget for the single
 * account being attacked.
 */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  max: env.isDev ? 200 : 20,
  keyGenerator: (req: Request) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : null;
    return email ? `email:${email}` : `ip:${clientKey(req)}`;
  },
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again after 15 minutes.',
  },
});

/**
 * Payment and other sensitive endpoints — 10 requests per 15 minutes per user.
 */
export const sensitiveLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  max: env.isDev ? 100 : 10,
  keyGenerator: userOrClientKey,
  message: {
    success: false,
    message: 'Too many requests for this sensitive operation. Please try again later.',
  },
});

/**
 * Order creation — 30 per 15 minutes per user.
 *
 * Looser than `sensitiveLimiter` because placing several print jobs in a row is
 * normal behaviour, but still bounded so a script cannot flood the orders table.
 */
export const orderCreationLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  max: env.isDev ? 200 : 30,
  keyGenerator: userOrClientKey,
  message: {
    success: false,
    message: 'Too many orders created. Please try again in a few minutes.',
  },
});

/**
 * OTP issuance — 5 per 15 minutes per user.
 *
 * The lockout inside verifyOTP throttles wrong *guesses*; nothing throttled
 * re-issuance, so a caller could spray OTP emails from an admin's own account.
 */
export const otpRequestLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  max: env.isDev ? 50 : 5,
  keyGenerator: userOrClientKey,
  message: {
    success: false,
    message: 'Too many verification codes requested. Please wait before requesting another.',
  },
});

/**
 * Webhook limiter — 60 requests per minute.
 * Razorpay won't exceed this for legitimate traffic. Prevents attackers from
 * flooding the endpoint with fake payloads that burn CPU on HMAC verification
 * and DB lookups before rejection.
 */
export const webhookLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  max: 60,
  message: {
    success: false,
    message: 'Too many webhook requests.',
  },
});
