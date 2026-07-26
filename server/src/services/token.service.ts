import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';

/**
 * JWT Token Service
 *
 * Handles access token generation/verification and refresh token
 * lifecycle (create, rotate, revoke).
 *
 * Design decisions (interview-ready):
 * - Access tokens: Short-lived (15min), stateless, carried in Authorization header
 * - Refresh tokens: Long-lived (7d), stored as SHA-256 hash in DB for revocation
 * - Token rotation: Each refresh generates a new refresh token and revokes the old one
 * - This prevents replay attacks — a stolen refresh token can only be used once
 */

export interface TokenPayload {
  userId: string;
  userType: 'STUDENT' | 'SHOP_OWNER' | 'ADMIN';
  email?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: string;
}

/**
 * Generate a JWT access token.
 * Short-lived, contains user identity for stateless auth.
 */
export function generateAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  });
}

/**
 * Verify and decode a JWT access token.
 */
export function verifyAccessToken(token: string): TokenPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as TokenPayload;
  } catch {
    throw ApiError.unauthorized('Invalid or expired access token');
  }
}

/**
 * Hash a refresh token using SHA-256 for secure DB storage.
 * We never store the raw token — only the hash.
 */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a cryptographically random refresh token string.
 */
function generateRandomToken(): string {
  return crypto.randomBytes(40).toString('hex');
}

/**
 * Create a new token pair (access + refresh).
 * The refresh token is stored as a hash in the database.
 */
export async function generateTokenPair(
  payload: TokenPayload,
  deviceInfo?: string,
  ip?: string
): Promise<TokenPair> {
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRandomToken();
  const tokenHash = hashToken(refreshToken);

  // Calculate expiry from env config (e.g., "7d" → 7 days from now)
  const daysMatch = env.JWT_REFRESH_EXPIRES_IN.match(/^(\d+)d$/);
  const days = daysMatch ? parseInt(daysMatch[1], 10) : 7;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  // Store hashed refresh token in DB
  await prisma.refreshToken.create({
    data: {
      userId: payload.userId,
      tokenHash,
      expiresAt,
      deviceInfo: deviceInfo?.substring(0, 255), // Truncate long user-agents
      ip,
    },
  });

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresIn: env.JWT_ACCESS_EXPIRES_IN,
  };
}

/**
 * Rotate a refresh token — verify the old one, revoke it, issue a new pair.
 *
 * This is "refresh token rotation": each use of a refresh token invalidates
 * it and issues a brand new one. If an attacker replays a revoked token,
 * we detect it and can revoke ALL tokens for that user (breach detection).
 */
export async function rotateRefreshToken(
  oldRefreshToken: string,
  deviceInfo?: string,
  ip?: string
): Promise<TokenPair> {
  const tokenHash = hashToken(oldRefreshToken);

  // Find the token in DB
  const storedToken = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  // Token not found
  if (!storedToken) {
    throw ApiError.unauthorized('Invalid refresh token');
  }

  // Token already revoked — possible replay attack!
  // In production, you'd revoke ALL tokens for this user as a security measure.
  if (storedToken.isRevoked) {
    // Revoke all tokens for this user (breach detection)
    await prisma.refreshToken.updateMany({
      where: { userId: storedToken.userId },
      data: { isRevoked: true },
    });
    throw ApiError.unauthorized('Refresh token reuse detected — all sessions revoked');
  }

  // Token expired
  if (storedToken.expiresAt < new Date()) {
    await prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { isRevoked: true },
    });
    throw ApiError.unauthorized('Refresh token expired');
  }

  // Revoke the old token
  await prisma.refreshToken.update({
    where: { id: storedToken.id },
    data: { isRevoked: true },
  });

  // Generate new token pair
  const payload: TokenPayload = {
    userId: storedToken.user.id,
    userType: storedToken.user.type,
    email: storedToken.user.email ?? undefined,
  };

  return generateTokenPair(payload, deviceInfo, ip);
}

/**
 * Revoke a specific refresh token (logout from one device).
 */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  const tokenHash = hashToken(refreshToken);

  await prisma.refreshToken.updateMany({
    where: { tokenHash },
    data: { isRevoked: true },
  });
}

/**
 * Revoke ALL refresh tokens for a user (logout from all devices).
 */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, isRevoked: false },
    data: { isRevoked: true },
  });
}

/**
 * Clean up expired refresh tokens (called by a cron job in Phase 6).
 */
export async function cleanupExpiredTokens(): Promise<number> {
  const result = await prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        { isRevoked: true, createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      ],
    },
  });
  return result.count;
}
