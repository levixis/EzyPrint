import { Router } from 'express';
import { authLimiter, authSourceLimiter, passwordResetLimiter } from '../middleware/rateLimiter';
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
 * The second half of the credential-attack budget, applied per source address.
 *
 * `authLimiter` keys on the target account when the body carries an email, and
 * falls back to the address only when it does not — so a request naming an
 * account was never counted against where it came from. One host could
 * therefore spray a password across as many accounts as it knew of and hit no
 * auth limit at all, because each account had its own untouched budget.
 *
 * Mounted per route rather than on the router, and only on the routes that
 * verify a credential. `/refresh`, `/logout` and `/me` are ordinary traffic
 * from users who are already signed in — a campus puts thousands of them behind
 * one institutional NAT address, and counting their token refreshes against a
 * shared per-address budget would read as an outage rather than a protection.
 * That is the same reasoning that keeps `generalLimiter` off the address, and
 * it is why this cannot simply be `router.use`.
 */
const credentialGuess = [authSourceLimiter];

/**
 * POST /api/v1/auth/register
 * Zod validates: email format, password strength (8-72 chars, uppercase,
 * lowercase, number, special char), name length, type enum, conditional
 * shopName/shopAddress for SHOP_OWNER.
 */
router.post('/register', ...credentialGuess, validate(registerSchema), authController.register);

/**
 * POST /api/v1/auth/login
 * Zod validates: email format, password presence.
 */
router.post('/login', ...credentialGuess, validate(loginSchema), authController.login);

/**
 * POST /api/v1/auth/forgot-password
 *
 * `passwordResetLimiter` stacks on top of the router-wide `authLimiter`: this
 * endpoint sends mail to an address the caller names, so the binding limit is
 * 3/hour per address rather than 20/15min.
 */
router.post(
  '/forgot-password',
  ...credentialGuess,
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
  ...credentialGuess,
  validate(resetPasswordSchema),
  authController.resetPasswordHandler
);

/**
 * POST /api/v1/auth/google
 * Zod validates: idToken presence, optional userType enum.
 */
router.post('/google', ...credentialGuess, validate(googleAuthSchema), authController.googleAuth);

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
