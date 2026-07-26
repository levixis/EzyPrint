import { Router } from 'express';
import { authLimiter } from '../middleware/rateLimiter';
import { authenticate } from '../middleware/auth';
import * as authController from '../controllers/auth.controller';

const router = Router();

// Apply stricter rate limiting to all auth endpoints (20 req / 15 min)
router.use(authLimiter);

/**
 * POST /api/v1/auth/register
 * Register a new user with email + password.
 * Body: { email, password, name, type, shopName?, shopAddress? }
 */
router.post('/register', authController.register);

/**
 * POST /api/v1/auth/login
 * Login with email + password → returns JWT access + refresh tokens.
 * Body: { email, password }
 */
router.post('/login', authController.login);

/**
 * POST /api/v1/auth/google
 * Login or register via Google OAuth.
 * Body: { idToken, userType? }
 */
router.post('/google', authController.googleAuth);

/**
 * POST /api/v1/auth/refresh
 * Exchange a refresh token for a new access + refresh token pair.
 * Body: { refreshToken }
 */
router.post('/refresh', authController.refresh);

/**
 * POST /api/v1/auth/logout
 * Revoke a specific refresh token (single device logout).
 * Body: { refreshToken }
 */
router.post('/logout', authController.logoutHandler);

/**
 * POST /api/v1/auth/logout-all
 * Revoke ALL refresh tokens for the authenticated user (all devices).
 * Requires: Bearer token in Authorization header.
 */
router.post('/logout-all', authenticate, authController.logoutAllHandler);

/**
 * GET /api/v1/auth/me
 * Get the authenticated user's profile.
 * Requires: Bearer token in Authorization header.
 */
router.get('/me', authenticate, authController.me);

export default router;
