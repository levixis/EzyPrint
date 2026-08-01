/**
 * Unit Tests — Security Middleware
 *
 * Tests request body cleaning, HTML escaping at the email sink, path
 * traversal blocking, and other server-side protections.
 */

import { sanitizeBody, blockPathTraversal } from '../../middleware/security';
import { escapeHtml } from '../../services/email.service';
import { Request, Response, NextFunction } from 'express';

// Mock Express objects
function mockReq(body?: any, params?: any): Partial<Request> {
  return { body, params: params || {} };
}
function mockRes(): Partial<Response> {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
function mockNext(): NextFunction {
  return jest.fn();
}

// ────────────────────────────────────────────────────────────
// XSS SANITIZATION
// ────────────────────────────────────────────────────────────

describe('Request body cleaning (sanitizeBody)', () => {
  // This middleware deliberately does NOT HTML-encode input. It used to, which
  // corrupted stored data ("AT&T Print" was saved mangled, and React escaped it
  // again on render so users saw entity text) while adding nothing — the only
  // consumer is a React frontend that escapes text nodes by default and has no
  // dangerouslySetInnerHTML anywhere. XSS defence lives in Zod validation, React's
  // escaping, and explicit escapeHtml at the one HTML sink (email templates).

  test('leaves user text exactly as entered', () => {
    const req = mockReq({ name: 'AT&T Print > Fast <Campus>' });
    const next = mockNext();
    sanitizeBody(req as Request, mockRes() as Response, next);
    expect(req.body.name).toBe('AT&T Print > Fast <Campus>');
    expect(next).toHaveBeenCalled();
  });

  test('strips null bytes, which are never meaningful in user text', () => {
    const req = mockReq({ name: 'shop\u0000name' });
    sanitizeBody(req as Request, mockRes() as Response, mockNext());
    expect(req.body.name).toBe('shopname');
  });

  test('cleans nested objects recursively', () => {
    const req = mockReq({ user: { address: { city: 'Mum\u0000bai' } } });
    sanitizeBody(req as Request, mockRes() as Response, mockNext());
    expect(req.body.user.address.city).toBe('Mumbai');
  });

  test('cleans arrays', () => {
    const req = mockReq({ tags: ['a\u0000b', 'safe'] });
    sanitizeBody(req as Request, mockRes() as Response, mockNext());
    expect(req.body.tags[0]).toBe('ab');
    expect(req.body.tags[1]).toBe('safe');
  });

  test('leaves non-string values untouched', () => {
    const req = mockReq({ count: 42, active: true, data: null });
    sanitizeBody(req as Request, mockRes() as Response, mockNext());
    expect(req.body.count).toBe(42);
    expect(req.body.active).toBe(true);
    expect(req.body.data).toBeNull();
  });

  test('handles empty body gracefully', () => {
    const req = mockReq(undefined);
    const next = mockNext();
    sanitizeBody(req as Request, mockRes() as Response, next);
    expect(next).toHaveBeenCalled();
  });

  test('skips webhook routes so the HMAC payload is untouched', () => {
    const req: any = { body: { raw: 'a\u0000b' }, params: {}, originalUrl: '/api/v1/payments/webhook' };
    sanitizeBody(req as Request, mockRes() as Response, mockNext());
    expect(req.body.raw).toBe('a\u0000b');
  });
});

// ────────────────────────────────────────────────────────────
// HTML ESCAPING AT THE EMAIL SINK
// ────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  test('escapes the characters that break out of an HTML context', () => {
    expect(escapeHtml('<script>alert("x")</script>'))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  test('escapes ampersands first so entities are not double-decoded', () => {
    expect(escapeHtml('AT&T <b>')).toBe('AT&amp;T &lt;b&gt;');
  });

  test('leaves ordinary text alone', () => {
    expect(escapeHtml('DELETE_USER')).toBe('DELETE_USER');
  });
});

// ────────────────────────────────────────────────────────────
// PATH TRAVERSAL
// ────────────────────────────────────────────────────────────

describe('Path Traversal Protection', () => {
  test('blocks .. in params', () => {
    const req = mockReq({}, { file: '../../etc/passwd' });
    const res = mockRes();
    blockPathTraversal(req as Request, res as Response, mockNext());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('blocks URL-encoded .. in params', () => {
    const req = mockReq({}, { file: '%2e%2e/etc/passwd' });
    const res = mockRes();
    blockPathTraversal(req as Request, res as Response, mockNext());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('allows normal params', () => {
    const req = mockReq({}, { file: 'orders/abc-123-test.pdf' });
    const next = mockNext();
    blockPathTraversal(req as Request, next as any as Response, next);
    expect(next).toHaveBeenCalled();
  });
});
