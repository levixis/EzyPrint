import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { env } from '../config/env';
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

// Fetches and caches Google's public signing keys for id_token verification.
const googleClient = new OAuth2Client();

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
  referralCode?: string;
}

interface AuthResponse {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    type: UserType;
    profilePhotoUrl: string | null;
    shopId?: string;
    shopName?: string;
    isShopApproved?: boolean;
    isShopArchived?: boolean;
    isShopRejected?: boolean;
    shopRejectionReason?: string | null;
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
  const { email, password, name, type, shopName, shopAddress, referralCode } = input;

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
  let shopId: string | undefined = undefined;
  const user = await prisma.$transaction(async (tx) => {
    // If registering as shop owner, validate and redeem the referral code
    // atomically. All three are required, matching the guard on the shop
    // creation below — see the note on the Google path.
    if (type === 'SHOP_OWNER') {
      if (!referralCode || !shopName || !shopAddress) {
        throw ApiError.badRequest('A shop name, address, and referral code are required to open a shop.');
      }
    }

    const newUser = await tx.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        type,
      },
    });

    // If registering as shop owner, create the shop profile too
    if (type === 'SHOP_OWNER' && shopName && shopAddress && referralCode) {
      // Guarded on `usedAt`, not `usedBy`: `usedBy` is now a foreign key that
      // goes null if the owner's account is deleted, which would make a spent
      // code redeemable a second time. `usedAt` records the same event in the
      // same statement and is never cleared. The claim itself is unchanged —
      // one updateMany, and count === 0 means somebody else took it first.
      const result = await tx.referralCode.updateMany({
        where: {
          code: referralCode,
          usedAt: null,
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: new Date() } }
          ]
        },
        data: { usedBy: newUser.id, usedAt: new Date() },
      });
      if (result.count === 0) {
        throw ApiError.badRequest('Invalid, expired, or already-used referral code.');
      }

      const shop = await tx.shop.create({
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
      shopId = shop.id;
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
      shopId,
      shopName,
      isShopApproved: shopId ? false : undefined,
      isShopArchived: shopId ? false : undefined,
      isShopRejected: shopId ? false : undefined,
      shopRejectionReason: undefined,
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
  const user = await prisma.user.findUnique({ 
    where: { email },
    include: { shop: { select: { id: true, name: true, isApproved: true, isArchived: true, isRejected: true, rejectionReason: true } } }
  });

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
      shopId: user.shop?.id,
      shopName: user.shop?.name,
      isShopApproved: user.shop?.isApproved,
      isShopArchived: user.shop?.isArchived,
      isShopRejected: user.shop?.isRejected,
      shopRejectionReason: user.shop?.rejectionReason,
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


/**
 * Verify a Google token and extract user info.
 *
 * The frontend sends two different token types under the same field: native
 * Capacitor sign-in yields an OpenID id_token, while the web popup
 * (`initTokenClient`) yields an OAuth2 access_token. Both are handled.
 *
 * Whichever type arrives, the `aud` claim must name one of our own client IDs.
 * Google's introspection endpoints confirm that a token is genuine, not that it
 * was meant for us — so without the audience check, a token harvested from any
 * unrelated "Sign in with Google" site would log its bearer in as that user.
 */
async function verifyGoogleToken(token: string): Promise<GoogleUserInfo> {
  if (env.GOOGLE_CLIENT_IDS.length === 0) {
    // Fail closed. Accepting tokens without a known audience means accepting
    // tokens minted for someone else's Google app.
    throw ApiError.internal('Google sign-in is not configured on this server.');
  }

  // ── Path 1: OpenID id_token (native Capacitor sign-in) ──
  // verifyIdToken checks the RS256 signature against Google's published keys,
  // the issuer, the expiry, AND that `aud` is one of ours.
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: env.GOOGLE_CLIENT_IDS,
    });
    const payload = ticket.getPayload();

    if (payload?.sub && payload.email) {
      assertEmailVerified(payload.email_verified, payload.email);
      return {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name || payload.email.split('@')[0],
        profilePhotoUrl: payload.picture,
      };
    }
  } catch {
    // Not a valid id_token — fall through and try the access_token path.
    // Any genuine audience/signature failure is re-checked below and rejected.
  }

  // ── Path 2: OAuth2 access_token (web popup via initTokenClient) ──
  // An access token carries no verifiable signature we can check locally, so we
  // ask Google what it was issued for. The `aud` in this response is the only
  // thing tying the token to EzyPrint rather than to an attacker's own app.
  const introspection = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`
  );

  if (!introspection.ok) {
    throw ApiError.unauthorized('Invalid Google token');
  }

  const info = (await introspection.json()) as {
    aud?: string;
    sub?: string;
    email?: string;
    email_verified?: string | boolean;
    expires_in?: string;
  };

  if (!info.aud || !env.GOOGLE_CLIENT_IDS.includes(info.aud)) {
    // The token is a real Google token, but it was issued to a different
    // application. Replaying one here would be account takeover.
    throw ApiError.unauthorized('Google token was not issued for this application');
  }

  if (!info.sub || !info.email) {
    throw ApiError.unauthorized('Invalid Google token payload');
  }

  assertEmailVerified(info.email_verified, info.email);

  // Audience is confirmed, so it is now safe to spend the token on a profile
  // lookup for the display name and avatar.
  let name: string | undefined;
  let profilePhotoUrl: string | undefined;
  try {
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (profileRes.ok) {
      const profile = (await profileRes.json()) as { name?: string; picture?: string };
      name = profile.name;
      profilePhotoUrl = profile.picture;
    }
  } catch {
    // Profile enrichment is cosmetic — a failure here must not block sign-in.
  }

  return {
    googleId: info.sub,
    email: info.email,
    name: name || info.email.split('@')[0],
    profilePhotoUrl,
  };
}

/**
 * Reject unverified Google emails.
 *
 * `loginWithGoogle` matches an existing account by email, so accepting an
 * unverified address would let someone register a Google account claiming a
 * victim's email and inherit their EzyPrint account.
 */
function assertEmailVerified(verified: string | boolean | undefined, email: string): void {
  const isVerified = verified === true || verified === 'true';
  if (!isVerified) {
    throw ApiError.unauthorized(
      `Google account ${email} does not have a verified email address.`
    );
  }
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
  token: string,
  userType?: UserType,
  shopName?: string,
  shopAddress?: string,
  referralCode?: string,
  deviceInfo?: string,
  ip?: string
): Promise<AuthResponse | { isNewUser: true; googleUser: GoogleUserInfo }> {
  const googleUser = await verifyGoogleToken(token);

  // Check if user already exists (by googleId or email)
  let user = await prisma.user.findFirst({
    where: {
      OR: [
        { googleId: googleUser.googleId },
        { email: googleUser.email },
      ],
    },
    include: { shop: { select: { id: true, name: true, isApproved: true, isArchived: true, isRejected: true, rejectionReason: true } } },
  });

  let shopId: string | undefined = user?.shop?.id;
  let resolvedShopName: string | undefined = user?.shop?.name;

  if (user) {
    // Update Google ID and photo if missing (user registered with email first)
    if (!user.googleId || !user.profilePhotoUrl) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: googleUser.googleId,
          profilePhotoUrl: googleUser.profilePhotoUrl || user.profilePhotoUrl,
        },
        include: { shop: { select: { id: true, name: true, isApproved: true, isArchived: true, isRejected: true, rejectionReason: true } } },
      });
      shopId = user.shop?.id;
      resolvedShopName = user.shop?.name;
    }
  } else {
    // User does not exist. If frontend didn't specify a userType, ask them to complete profile.
    if (!userType) {
      return { isNewUser: true, googleUser };
    }

    // Create new user (and shop if applicable) inside a transaction
    user = (await prisma.$transaction(async (tx) => {
      if (userType === 'SHOP_OWNER') {
        // All three, not just the code. The shop creation below is guarded on
        // the same three values, so checking only `referralCode` here let a
        // request with a code but no shop name fall through and create an owner
        // account with no shop — a state every shop-scoped route then has to
        // defend against, and one of them did not.
        if (!referralCode || !shopName || !shopAddress) {
          throw ApiError.badRequest('A shop name, address, and referral code are required to open a shop.');
        }
      }

      const newUser = await tx.user.create({
        data: {
          email: googleUser.email,
          name: googleUser.name,
          googleId: googleUser.googleId,
          profilePhotoUrl: googleUser.profilePhotoUrl,
          type: userType,
        },
      });

      if (userType === 'SHOP_OWNER' && shopName && shopAddress && referralCode) {
        // Same claim as the password path — see the note there on why this
        // guards `usedAt` rather than `usedBy`.
        const result = await tx.referralCode.updateMany({
          where: {
            code: referralCode,
            usedAt: null,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: new Date() } }
            ]
          },
          data: { usedBy: newUser.id, usedAt: new Date() },
        });
        if (result.count === 0) {
          throw ApiError.badRequest('Invalid, expired, or already-used referral code.');
        }

        const shop = await tx.shop.create({
          data: {
            ownerUserId: newUser.id,
            name: shopName,
            address: shopAddress,
            // Pricing is deliberately not set here. `bwPerPage` and
            // `colorPerPage` are paise, and these lines used to pass 1 and 3 —
            // rupee figures that survived the paise migration because it
            // converted stored data, not code. Every shop registered after it
            // was priced at one paise a page. The schema holds the defaults
            // (100 / 300); one source of truth cannot drift from itself.
            isOpen: false,
            isApproved: false,
          },
        });
        shopId = shop.id;
        resolvedShopName = shopName;
      }
      
      return newUser;
    })) as any;
  }

  if (!user) {
    throw ApiError.internal('Failed to create or find user');
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
      shopId,
      shopName: resolvedShopName,
      isShopApproved: shopId ? (user.shop?.isApproved ?? false) : undefined,
      isShopArchived: shopId ? (user.shop?.isArchived ?? false) : undefined,
      isShopRejected: shopId ? (user.shop?.isRejected ?? false) : undefined,
      shopRejectionReason: shopId ? (user.shop?.rejectionReason ?? null) : undefined,
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
          isRejected: true,
          rejectionReason: true,
        },
      },
    },
  });

  if (!user) {
    throw ApiError.notFound('User not found');
  }

  const { shop, ...userData } = user;
  
  return {
    ...userData,
    shopId: shop?.id,
    shopName: shop?.name,
    isShopApproved: shop?.isApproved,
    isShopArchived: shop?.isArchived,
    isShopRejected: shop?.isRejected,
    shopRejectionReason: shop?.rejectionReason,
    shop,
  };
}
