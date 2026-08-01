import { Request, Response, NextFunction } from 'express';
import {
  registerWithEmail,
  loginWithEmail,
  loginWithGoogle,
  refreshTokens,
  logout,
  logoutAll,
  getCurrentUser,
} from '../services/auth.service';
import { ApiError } from '../utils/ApiError';

/**
 * Auth Controller — thin request handlers that delegate to auth.service.
 *
 * Each handler:
 * 1. Extracts & validates input from the request
 * 2. Calls the appropriate service method
 * 3. Returns a consistent JSON response
 *
 * All errors are thrown and caught by the centralized error handler.
 */

/**
 * POST /api/v1/auth/register
 * Body: { email, password, name, type, shopName?, shopAddress? }
 */
export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password, name, type, shopName, shopAddress, referralCode } = req.body;

    // Zod schema (validate middleware) already validates all fields.
    // No manual checks needed here.

    const result = await registerWithEmail(
      { email, password, name, type, shopName, shopAddress, referralCode },
      req.headers['user-agent'],
      req.ip
    );

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/auth/login
 * Body: { email, password }
 */
export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body;

    const result = await loginWithEmail(email, password, req.headers['user-agent'], req.ip);

    res.json({
      success: true,
      message: 'Login successful',
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/auth/google
 * Body: { idToken, userType?, shopName?, shopAddress?, referralCode? }
 *
 * The frontend sends the Google ID token obtained from Google Sign-In SDK.
 * We verify it server-side and create/find the user.
 */
export async function googleAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const { idToken, userType, shopName, shopAddress, referralCode } = req.body;

    if (!idToken) {
      throw ApiError.badRequest('Google ID token is required');
    }

    const result = await loginWithGoogle(
      idToken,
      userType,
      shopName,
      shopAddress,
      referralCode,
      req.headers['user-agent'],
      req.ip
    );

    if ('isNewUser' in result) {
      res.json({
        success: true,
        data: {
          isNewUser: true,
          ...result.googleUser,
        },
      });
      return;
    }

    res.json({
      success: true,
      message: 'Google authentication successful',
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/auth/refresh
 * Body: { refreshToken }
 *
 * Uses refresh token rotation — the old token is revoked and a new pair is issued.
 */
export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw ApiError.badRequest('Refresh token is required');
    }

    const tokens = await refreshTokens(
      refreshToken,
      req.headers['user-agent'],
      req.ip
    );

    res.json({
      success: true,
      message: 'Tokens refreshed',
      data: { tokens },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/auth/logout
 * Body: { refreshToken }
 *
 * Revokes the specific refresh token (single device logout).
 */
export async function logoutHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await logout(refreshToken);
    }

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/auth/logout-all
 * Requires authentication — revokes ALL refresh tokens for the user.
 */
export async function logoutAllHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) {
      throw ApiError.unauthorized('Authentication required');
    }

    await logoutAll(req.user.userId);

    res.json({
      success: true,
      message: 'Logged out from all devices',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/auth/me
 * Returns the current authenticated user's profile.
 */
export async function me(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) {
      throw ApiError.unauthorized('Authentication required');
    }

    const user = await getCurrentUser(req.user.userId);

    res.json({
      success: true,
      data: { user },
    });
  } catch (error) {
    next(error);
  }
}
