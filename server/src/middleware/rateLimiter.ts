import crypto from 'crypto';
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
export function userOrClientKey(req: Request): string {
  const userId = (req as Request & { user?: { userId?: string } }).user?.userId;
  return userId ? `user:${userId}` : `ip:${clientKey(req)}`;
}

/**
 * Key on the bearer token presented, otherwise the client address.
 *
 * `userOrClientKey` is useless to any limiter mounted app-wide, because those
 * run before `authenticate` and `req.user` does not exist yet. The token itself
 * is available at that point, and it identifies a session as well as the user
 * id it decodes to.
 *
 * Hashed, so a bucket key is never a credential — rate-limit state is held in
 * memory and surfaced in logs and headers, and a raw JWT has no business in any
 * of them.
 *
 * The token is not verified here, so a caller could mint gibberish tokens to
 * get fresh buckets. That trade is worth taking: those requests die at
 * `authenticate` with a 401 a moment later, whereas the alternative — one
 * bucket per address — throttles an entire campus behind one NAT address to a
 * hundred requests between them. Volumetric attacks are the platform's job,
 * not this middleware's.
 */
export function tokenOrClientKey(req: Request): string {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) {
      return `tok:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
    }
  }
  return `ip:${clientKey(req)}`;
}

/**
 * Whether a path is a liveness probe, which must never be throttled.
 *
 * Matched exactly rather than by substring: `/v1/shops/health-clinic` is a real
 * endpoint and must stay counted.
 *
 * `path` is relative to where the limiter is mounted ('/api/'), which is why
 * these start at '/v1'.
 */
export function isHealthCheckPath(path: string): boolean {
  return path === '/v1/health' || path.startsWith('/v1/health/');
}

/**
 * General API rate limiter — 100 requests per 15 minutes.
 *
 * Keyed on the caller's session token, falling back to the address only for
 * callers we cannot identify. Keying on the address alone is wrong for this
 * product in a way that would have surfaced on day one: a campus puts its
 * entire student body behind one institutional NAT address, so a shared bucket
 * is 100 requests per fifteen minutes for thirty thousand people between them.
 * The first busy hour would have looked like an outage, and the logs would have
 * blamed the students for abuse.
 *
 * Unauthenticated traffic still shares by address, which is correct — that is
 * mostly login and registration, and those have their own limiter keyed on the
 * target account.
 *
 * Health checks are exempt. Render probes liveness far more often than once
 * every nine seconds, so the probe alone exhausted the shared bucket; the
 * platform then read our own 429 as the service being unhealthy and killed the
 * instance. A liveness probe answering "too many requests" is not a signal
 * anyone wants — it makes the limiter an outage rather than a protection.
 */
export const generalLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  // 300, not 100. The bucket is per access token, and nobody had checked it
  // against what the client actually sends: a signed-in session polled 165
  // requests per fifteen minutes, so the app rate-limited its own users from
  // about the nine-minute mark of every token lifetime. The client now sends
  // far less (see POLL_INTERVAL / SLOW_POLL_INTERVAL in AppContext), and this
  // is the headroom on top of that fix rather than a substitute for it — a
  // student with a live order still sends ~120, which the old ceiling of 100
  // would have refused even after the polling change.
  max: env.isDev ? 1000 : 300,
  keyGenerator: tokenOrClientKey,
  skip: (req: Request) => isHealthCheckPath(req.path),
  message: {
    success: false,
    message: 'Too many requests. Please try again after 15 minutes.',
  },
});

/**
 * Auth endpoints, per targeted account — 20 attempts per 15 minutes.
 *
 * Bounds the attack on any single account no matter how many addresses it is
 * spread across. It does NOT bound how many accounts one address may work
 * through, which is why `authSourceLimiter` below is mounted alongside it.
 *
 * These have to be two limiters rather than one. The key was previously
 * `email ? email : ip` — the address component vanished the moment an email was
 * present, which is every login and registration attempt, so each target got
 * its own fresh budget and one host could try 20 passwords against every
 * account it knew of. A composite `email|ip` key is worse still: changing
 * either half mints a new bucket, so it bounds neither axis. Two independent
 * buckets, both of which must have room, is the only shape that does.
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
 * Credential-verifying endpoints, per source address — 60 attempts per 15 min.
 *
 * The other half of the pair: this is what makes password spraying — one or two
 * common passwords against thousands of known campus addresses — cost the
 * attacker something.
 *
 * Deliberately looser than the per-account limit, and deliberately mounted only
 * on login, register, google and the password-reset pair rather than on the
 * whole auth router. A campus puts its entire student body behind one
 * institutional NAT address, so anything keyed on the address alone has to stay
 * well clear of ordinary traffic; `/refresh` and `/me` are ordinary traffic and
 * are excluded entirely. Sixty credential attempts in fifteen minutes from one
 * address is far above real signup and sign-in volume, and far below a spray
 * worth running.
 */
export const authSourceLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  max: env.isDev ? 500 : 60,
  keyGenerator: (req: Request) => `authip:${clientKey(req)}`,
  message: {
    success: false,
    message: 'Too many authentication attempts from this network. Please try again later.',
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
 * Password reset requests — 3 per hour per email address.
 *
 * Much tighter than `authLimiter`'s 20/15min, and for a different threat. This
 * endpoint makes us send mail to an address chosen by an anonymous caller, so
 * the abuse is not guessing a credential — it is using EzyPrint to flood
 * somebody's inbox, and burning the mail provider's quota and reputation while
 * doing it. Three is more than anyone needs; a code lasts five minutes and the
 * usual reason to ask twice is that the first went to spam.
 *
 * Keyed on the target address rather than the caller, because the address is
 * what is being attacked and an attacker can change IP freely.
 */
export const passwordResetLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 60 * 1000,
  max: env.isDev ? 50 : 3,
  keyGenerator: (req: Request) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : null;
    return email ? `reset:${email}` : `ip:${clientKey(req)}`;
  },
  message: {
    success: false,
    message: 'Too many password reset requests for this email. Please try again later.',
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
