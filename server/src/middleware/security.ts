import { Request, Response, NextFunction } from 'express';

/**
 * Security middleware — server-side hardening.
 *
 * CRITICAL: These protections must NEVER rely on client-side enforcement.
 * The client is untrusted. Every check here assumes a hostile client.
 */

/**
 * Sanitize string inputs — strip potential XSS vectors.
 * Runs on every request body recursively.
 */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/javascript:/gi, '')
      .replace(/on\w+=/gi, '')    // onclick=, onerror=, etc.
      .replace(/data:text\/html/gi, '');
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (typeof value === 'object' && value !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      sanitized[key] = sanitizeValue(val);
    }
    return sanitized;
  }
  return value;
}

/**
 * Middleware: Sanitize all request body strings to prevent stored XSS.
 * Works recursively on nested objects and arrays.
 */
export function sanitizeBody(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
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
