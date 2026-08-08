import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';
import { captureError } from '../services/observability.service';
import * as alert from '../services/alert.service';

/**
 * Centralized error handling middleware.
 *
 * Catches all errors thrown in route handlers and sends a consistent
 * JSON error response. In development, includes the stack trace.
 *
 * Must be registered LAST in the middleware chain (after all routes).
 */
export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Default to 500 if not an ApiError
  let statusCode = 500;
  let message = 'Internal server error';
  let isOperational = false;

  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    message = err.message;
    isOperational = err.isOperational;
  } else if (err.name === 'ValidationError') {
    // Zod or other validation errors
    statusCode = 400;
    message = err.message;
    isOperational = true;
  } else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token';
    isOperational = true;
  } else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token expired';
    isOperational = true;
  }

  // Log non-operational errors (unexpected bugs)
  if (!isOperational) {
    console.error('💥 UNHANDLED ERROR:', err);

    // Record and, if it is new or the cooldown has passed, alert.
    //
    // Only non-operational errors. An ApiError is the server correctly telling
    // a caller they did something wrong — a 404, a bad password, an expired
    // token — and paging on those means paging on normal traffic. What lands
    // here is the class nobody anticipated, which is exactly the class worth
    // being woken for.
    //
    // Deliberately not awaited: an error response must not wait on a database
    // write and an SMTP round trip. The floating promise is caught internally —
    // captureError never rejects — so there is nothing to leak.
    void (async () => {
      const event = await captureError({
        source: 'http',
        severity: 'ERROR',
        message: err.message || 'Unhandled error',
        // Path and method only. Never the body: it carries passwords, OTPs and
        // tokens, and system_events is rendered in the admin dashboard.
        context: { method: req.method, path: req.originalUrl, statusCode },
        error: err,
      });

      if (event) {
        await alert.maybeSend(event, {
          title: `Unhandled error on ${req.method} ${req.originalUrl}`,
          body: err.message || 'Unhandled error',
        });
      }
    })();
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(env.isDev && { stack: err.stack }),
  });
};

/**
 * Catch-all for undefined routes.
 * Must be registered after all valid routes.
 */
export const notFoundHandler = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
};
