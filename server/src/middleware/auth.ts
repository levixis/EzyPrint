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
 */
declare global {
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
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;

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
