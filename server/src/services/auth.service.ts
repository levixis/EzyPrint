import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import {
  generateTokenPair,
  revokeRefreshToken,
  revokeAllUserTokens,
  rotateRefreshToken,
  TokenPair,
} from './token.service';
import type { UserType } from '@prisma/client';

/**
 * Auth Service — core authentication business logic.
 *
 * Handles:
 * - Email/password registration and login
 * - Google OAuth (token verification + auto-registration)
 * - Token refresh and logout
 *
 * Design: No Passport.js — pure bcrypt + JWT implementation so you
 * understand and can explain every step in an interview.
 */

const SALT_ROUNDS = 12; // bcrypt cost factor — ~250ms on modern hardware

// ────────────────────────────────────────────────────────────
// REGISTRATION
// ────────────────────────────────────────────────────────────

interface RegisterInput {
  email: string;
  password: string;
  name: string;
  type: UserType;
  // For SHOP_OWNER registration
  shopName?: string;
  shopAddress?: string;
}

interface AuthResponse {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    type: UserType;
    profilePhotoUrl: string | null;
  };
  tokens: TokenPair;
}

/**
 * Register a new user with email and password.
 */
export async function registerWithEmail(
  input: RegisterInput,
  deviceInfo?: string,
  ip?: string
): Promise<AuthResponse> {
  const { email, password, name, type, shopName, shopAddress } = input;

  // Check if email already exists
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    throw ApiError.conflict('An account with this email already exists');
  }

  // Validate password strength
  if (password.length < 8) {
    throw ApiError.badRequest('Password must be at least 8 characters long');
  }

  // Hash password with bcrypt
  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

  // Create user (and shop if SHOP_OWNER) in a transaction
  const user = await prisma.$transaction(async (tx) => {
    const newUser = await tx.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        type,
      },
    });

    // If registering as shop owner, create the shop profile too
    if (type === 'SHOP_OWNER' && shopName && shopAddress) {
      await tx.shop.create({
        data: {
          ownerUserId: newUser.id,
          name: shopName,
          address: shopAddress,
          bwPerPage: 1,
          colorPerPage: 3,
          isOpen: false,
          isApproved: false,
        },
      });
    }

    return newUser;
  });

  // Generate token pair
  const tokens = await generateTokenPair(
    { userId: user.id, userType: user.type, email: user.email ?? undefined },
    deviceInfo,
    ip
  );

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      type: user.type,
      profilePhotoUrl: user.profilePhotoUrl,
    },
    tokens,
  };
}

// ────────────────────────────────────────────────────────────
// LOGIN
// ────────────────────────────────────────────────────────────

/**
 * Login with email and password.
 */
export async function loginWithEmail(
  email: string,
  password: string,
  deviceInfo?: string,
  ip?: string
): Promise<AuthResponse> {
  // Find user by email
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.password) {
    // Intentionally vague error — don't reveal if email exists
    throw ApiError.unauthorized('Invalid email or password');
  }

  // Compare password with stored hash
  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  // Generate token pair
  const tokens = await generateTokenPair(
    { userId: user.id, userType: user.type, email: user.email ?? undefined },
    deviceInfo,
    ip
  );

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      type: user.type,
      profilePhotoUrl: user.profilePhotoUrl,
    },
    tokens,
  };
}

// ────────────────────────────────────────────────────────────
// GOOGLE OAUTH
// ────────────────────────────────────────────────────────────

interface GoogleUserInfo {
  googleId: string;
  email: string;
  name: string;
  profilePhotoUrl?: string;
}

/** Shape of Google's tokeninfo response */
interface GoogleTokenInfoResponse {
  sub: string;      // Google user ID
  email: string;
  name?: string;
  picture?: string;
  email_verified?: string;
  aud?: string;     // Client ID the token was issued to
  iss?: string;     // Issuer
  exp?: string;     // Expiry timestamp
}

/**
 * Verify a Google ID token and extract user info.
 *
 * In production, you'd verify the token signature against Google's
 * public keys. For now, we decode and verify via Google's tokeninfo endpoint.
 * The frontend sends the Google ID token after the user completes Google Sign-In.
 */
async function verifyGoogleToken(idToken: string): Promise<GoogleUserInfo> {
  // Verify token with Google's tokeninfo endpoint
  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );

  if (!response.ok) {
    throw ApiError.unauthorized('Invalid Google token');
  }

  const payload = (await response.json()) as GoogleTokenInfoResponse;

  // Validate required fields
  if (!payload.sub || !payload.email) {
    throw ApiError.unauthorized('Invalid Google token payload');
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name || payload.email.split('@')[0],
    profilePhotoUrl: payload.picture,
  };
}

/**
 * Login or register via Google OAuth.
 *
 * Flow:
 * 1. Frontend does Google Sign-In → gets ID token
 * 2. Frontend sends ID token to this endpoint
 * 3. We verify the token with Google
 * 4. Find or create user in our DB
 * 5. Return JWT token pair
 */
export async function loginWithGoogle(
  idToken: string,
  userType: UserType = 'STUDENT',
  deviceInfo?: string,
  ip?: string
): Promise<AuthResponse> {
  const googleUser = await verifyGoogleToken(idToken);

  // Check if user already exists (by googleId or email)
  let user = await prisma.user.findFirst({
    where: {
      OR: [
        { googleId: googleUser.googleId },
        { email: googleUser.email },
      ],
    },
  });

  if (user) {
    // Update Google ID and photo if missing (user registered with email first)
    if (!user.googleId || !user.profilePhotoUrl) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: googleUser.googleId,
          profilePhotoUrl: googleUser.profilePhotoUrl || user.profilePhotoUrl,
        },
      });
    }
  } else {
    // Create new user
    user = await prisma.user.create({
      data: {
        email: googleUser.email,
        name: googleUser.name,
        googleId: googleUser.googleId,
        profilePhotoUrl: googleUser.profilePhotoUrl,
        type: userType,
      },
    });
  }

  // Generate token pair
  const tokens = await generateTokenPair(
    { userId: user.id, userType: user.type, email: user.email ?? undefined },
    deviceInfo,
    ip
  );

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      type: user.type,
      profilePhotoUrl: user.profilePhotoUrl,
    },
    tokens,
  };
}

// ────────────────────────────────────────────────────────────
// TOKEN REFRESH & LOGOUT
// ────────────────────────────────────────────────────────────

/**
 * Refresh tokens — rotates the refresh token and returns a new pair.
 */
export async function refreshTokens(
  refreshToken: string,
  deviceInfo?: string,
  ip?: string
): Promise<TokenPair> {
  return rotateRefreshToken(refreshToken, deviceInfo, ip);
}

/**
 * Logout — revoke a specific refresh token.
 */
export async function logout(refreshToken: string): Promise<void> {
  await revokeRefreshToken(refreshToken);
}

/**
 * Logout from all devices — revoke all refresh tokens for a user.
 */
export async function logoutAll(userId: string): Promise<void> {
  await revokeAllUserTokens(userId);
}

// ────────────────────────────────────────────────────────────
// USER LOOKUP (for middleware)
// ────────────────────────────────────────────────────────────

/**
 * Get current user profile from the database.
 */
export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      type: true,
      phone: true,
      profilePhotoUrl: true,
      hasStudentPass: true,
      studentPassActivatedAt: true,
      preferredLanguage: true,
      createdAt: true,
      shop: {
        select: {
          id: true,
          name: true,
          isOpen: true,
          isApproved: true,
          isArchived: true,
        },
      },
    },
  });

  if (!user) {
    throw ApiError.notFound('User not found');
  }

  return user;
}
