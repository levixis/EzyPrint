/**
 * Unit Tests — Security Middleware
 *
 * Tests the XSS sanitization, path traversal blocking, and other
 * security measures that protect the application.
 */

import { sanitizeBody, blockPathTraversal } from '../../middleware/security';
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

describe('XSS Sanitization (sanitizeBody)', () => {
  test('strips HTML tags from strings', () => {
    const req = mockReq({ name: '<script>alert(1)</script>' });
    const next = mockNext();
    sanitizeBody(req as Request, mockRes() as Response, next);
    expect(req.body.name).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(next).toHaveBeenCalled();
  });

  test('strips javascript: protocol', () => {
    const req = mockReq({ url: 'javascript:alert(1)' });
    sanitizeBody(req as Request, mockRes() as Response, mockNext());
    expect(req.body.url).not.toContain('javascript:');
  });

  test('strips onclick handlers', () => {
    const req = mockReq({ field: 'onclick=alert(1)' });
    sanitizeBody(req as Request, mockRes() as Response, mockNext());
    expect(req.body.field).not.toContain('onclick=');
  });

  test('strips onerror handlers', () => {
    const req = mockReq({ field: 'onerror=fetch("evil.com")' });
    sanitizeBody(req as Request, mockRes() as Response, mockNext());
    expect(req.body.field).not.toContain('onerror=');
  });

  test('sanitizes nested objects recursively', () => {
    const req = mockReq({
      user: {
        name: '<img src=x onerror=alert(1)>',
        address: { city: '<b>Mumbai</b>' },
      },
    });
    sanitizeBody(req as Request, mockRes() as Response, mockNext());
    expect(req.body.user.name).not.toContain('<img');
    expect(req.body.user.address.city).toBe('&lt;b&gt;Mumbai&lt;/b&gt;');
  });

  test('sanitizes arrays', () => {
    const req = mockReq({ tags: ['<script>x</script>', 'safe'] });
    sanitizeBody(req as Request, mockRes() as Response, mockNext());
    expect(req.body.tags[0]).not.toContain('<script>');
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
