import { Router } from 'express';
import { authLimiter } from '../middleware/rateLimiter';

const router = Router();

// Apply stricter rate limiting to all auth endpoints
router.use(authLimiter);

/**
 * POST /api/v1/auth/register
 * Register a new user (email + password)
 * → Phase 2 implementation
 */
router.post('/register', (_req, res) => {
  res.status(501).json({
    success: false,
    message: 'Auth registration — coming in Phase 2',
  });
});

/**
 * POST /api/v1/auth/login
 * Login with email + password → returns JWT tokens
 * → Phase 2 implementation
 */
router.post('/login', (_req, res) => {
  res.status(501).json({
    success: false,
    message: 'Auth login — coming in Phase 2',
  });
});

/**
 * POST /api/v1/auth/google
 * Login/register via Google OAuth
 * → Phase 2 implementation
 */
router.post('/google', (_req, res) => {
  res.status(501).json({
    success: false,
    message: 'Google OAuth — coming in Phase 2',
  });
});

/**
 * POST /api/v1/auth/refresh
 * Refresh access token using refresh token
 * → Phase 2 implementation
 */
router.post('/refresh', (_req, res) => {
  res.status(501).json({
    success: false,
    message: 'Token refresh — coming in Phase 2',
  });
});

/**
 * POST /api/v1/auth/logout
 * Invalidate refresh token
 * → Phase 2 implementation
 */
router.post('/logout', (_req, res) => {
  res.status(501).json({
    success: false,
    message: 'Logout — coming in Phase 2',
  });
});

export default router;
