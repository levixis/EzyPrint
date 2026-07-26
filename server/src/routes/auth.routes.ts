import { Router } from 'express';
import { authLimiter } from '../middleware/rateLimiter';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { registerSchema, loginSchema, googleAuthSchema, refreshSchema } from '../validators/schemas';
import * as authController from '../controllers/auth.controller';

const router = Router();

// Apply stricter rate limiting to all auth endpoints (20 req / 15 min)
router.use(authLimiter);

/**
 * POST /api/v1/auth/register
 * Zod validates: email format, password strength (8-72 chars, uppercase,
 * lowercase, number, special char), name length, type enum, conditional
 * shopName/shopAddress for SHOP_OWNER.
 */
router.post('/register', validate(registerSchema), authController.register);

/**
 * POST /api/v1/auth/login
 * Zod validates: email format, password presence.
 */
router.post('/login', validate(loginSchema), authController.login);

/**
 * POST /api/v1/auth/google
 * Zod validates: idToken presence, optional userType enum.
 */
router.post('/google', validate(googleAuthSchema), authController.googleAuth);

/**
 * POST /api/v1/auth/refresh
 * Zod validates: refreshToken presence.
 */
router.post('/refresh', validate(refreshSchema), authController.refresh);

/**
 * POST /api/v1/auth/logout
 */
router.post('/logout', authController.logoutHandler);

/**
 * POST /api/v1/auth/logout-all
 */
router.post('/logout-all', authenticate, authController.logoutAllHandler);

/**
 * GET /api/v1/auth/me
 */
router.get('/me', authenticate, authController.me);

export default router;
