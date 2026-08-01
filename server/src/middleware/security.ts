import { Request, Response, NextFunction } from 'express';

/**
 * Security middleware — server-side hardening.
 *
 * CRITICAL: These protections must NEVER rely on client-side enforcement.
 * The client is untrusted. Every check here assumes a hostile client.
 */

/** Characters that terminate a string in C-style consumers, and are never
 *  meaningful in user-entered text. */
const NULL_BYTES = /\0/g;

function stripNullBytes(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(NULL_BYTES, '');
  }
  if (Array.isArray(value)) {
    return value.map(stripNullBytes);
  }
  if (typeof value === 'object' && value !== null) {
    const cleaned: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      cleaned[key] = stripNullBytes(val);
    }
    return cleaned;
  }
  return value;
}

/**
 * Middleware: strip null bytes from request bodies.
 *
 * This deliberately does NOT HTML-encode input. The previous version rewrote
 * `<` and `>` to entities on every string of every request, which:
 *
 *   - corrupted stored data — a shop named "AT&T Print" was saved mangled, and
 *     React escaped it again on render so users saw the entity text; and
 *   - bought nothing, because the only consumer is a React frontend that
 *     escapes text nodes by default, and there is no `dangerouslySetInnerHTML`
 *     anywhere in it.
 *
 * A blocklist of `javascript:` / `on\w+=` substrings is not a sanitizer either;
 * it is bypassable and reads as protection that is not there. Real defences
 * are: Zod validation on shape and length (already applied per route), React's
 * escaping at render, and explicit escaping wherever a value is interpolated
 * into HTML — see `escapeHtml` in email.service.ts.
 */
export function sanitizeBody(req: Request, _res: Response, next: NextFunction) {
  // Skip webhook routes and raw buffers to preserve the exact bytes the HMAC
  // was computed over.
  if (req.originalUrl && req.originalUrl.includes('/webhook')) return next();
  if (Buffer.isBuffer(req.body)) return next();

  if (req.body && typeof req.body === 'object') {
    req.body = stripNullBytes(req.body);
  }
  next();
}

/**
 * Middleware: Block common path traversal attempts in params.
 */
export function blockPathTraversal(req: Request, _res: Response, next: NextFunction) {
  const params = Object.values(req.params);
  const hasDotDot = params.some(
    (p) => typeof p === 'string' && (p.includes('..') || p.includes('%2e%2e'))
  );
  if (hasDotDot) {
    return _res.status(400).json({
      success: false,
      message: 'Invalid path parameter',
    });
  }
  next();
}

/**
 * Middleware: Add security response headers beyond what Helmet provides.
 */
export function additionalSecurityHeaders(_req: Request, res: Response, next: NextFunction) {
  // Prevent browsers from MIME-sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Referrer policy for privacy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Permissions policy — disable dangerous browser features
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()'
  );
  next();
}
