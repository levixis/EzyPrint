import { Router } from 'express';
import { authLimiter, passwordResetLimiter } from '../middleware/rateLimiter';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  registerSchema,
  loginSchema,
  googleAuthSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '../validators/schemas';
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
 * POST /api/v1/auth/forgot-password
 *
 * `passwordResetLimiter` stacks on top of the router-wide `authLimiter`: this
 * endpoint sends mail to an address the caller names, so the binding limit is
 * 3/hour per address rather than 20/15min.
 */
router.post(
  '/forgot-password',
  passwordResetLimiter,
  validate(forgotPasswordSchema),
  authController.forgotPassword
);

/**
 * POST /api/v1/auth/reset-password
 * Zod validates: email format, 6-digit code, full password strength rules.
 *
 * Not behind `passwordResetLimiter` — submitting a code sends no mail, and
 * wrong guesses are already bounded by the OTP lockout (3 then 15 minutes),
 * which is per-account and so cannot be sidestepped by changing address.
 */
router.post(
  '/reset-password',
  validate(resetPasswordSchema),
  authController.resetPasswordHandler
);

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
