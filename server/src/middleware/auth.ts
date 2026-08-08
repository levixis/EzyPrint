import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

/**
 * JWT payload shape — extends after Phase 2 implementation.
 */
export interface JwtPayload {
  userId: string;
  userType: 'STUDENT' | 'SHOP_OWNER' | 'ADMIN';
  email?: string;
}

/**
 * Extend Express Request to carry authenticated user info.
 *
 * Declaration merging into `Express.Request` is the only way to add a property
 * to a third-party interface, and the namespace form is the shape Express's own
 * types are declared in — there is no ES module equivalent to merge into.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * Auth middleware — verifies JWT access token from Authorization header.
 *
 * Usage in routes:
 *   router.get('/profile', authenticate, controller.getProfile);
 */
export const authenticate = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw ApiError.unauthorized('Missing or invalid Authorization header');
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as JwtPayload;

    req.user = decoded;
    next();
  } catch (error) {
    if (error instanceof ApiError) {
      next(error);
    } else {
      next(ApiError.unauthorized('Invalid or expired token'));
    }
  }
};

/**
 * Optional Auth middleware — verifies JWT if present, but doesn't block if missing.
 */
export const optionalAuthenticate = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
      req.user = decoded;
    }
    next();
  } catch (error) {
    // If token is invalid/expired, we just ignore it and treat as unauthenticated
    next();
  }
};

/**
 * Role-based access control middleware.
 *
 * Usage:
 *   router.get('/admin/stats', authenticate, authorize('ADMIN'), controller.getStats);
 *   router.get('/shop/orders', authenticate, authorize('SHOP_OWNER', 'ADMIN'), controller.getOrders);
 */
export const authorize = (...allowedRoles: JwtPayload['userType'][]) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(ApiError.unauthorized('Authentication required'));
    }

    if (!allowedRoles.includes(req.user.userType)) {
      return next(ApiError.forbidden('You do not have permission to access this resource'));
    }

    next();
  };
};
