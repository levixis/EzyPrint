import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';

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
  _req: Request,
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
