import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { randomBytes } from 'crypto';

/**
 * Generate a random referral code (e.g. EZY-XXXXXXXXXX).
 *
 * Five bytes rather than three: a referral code is what authorises a stranger
 * to register as a shop owner, and 24 bits is small enough that codes start
 * colliding in the low thousands and are worth guessing at.
 */
function generateRandomCode(): string {
  return `EZY-${randomBytes(5).toString('hex').toUpperCase()}`;
}

/** Retries on the vanishingly unlikely event of a code collision. */
const MAX_CODE_ATTEMPTS = 5;

/**
 * Create a new referral code (Admin only).
 */
export async function createReferralCode(adminUserId: string, daysValid: number = 7) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + daysValid);

  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
    try {
      return await prisma.referralCode.create({
        data: {
          code: generateRandomCode(),
          createdBy: adminUserId,
          expiresAt,
        },
      });
    } catch (error) {
      // P2002 is the unique-constraint violation on `code`. Anything else is a
      // real failure and should surface. Previously a collision escaped as a
      // raw 500.
      const isCollision =
        typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
      if (!isCollision || attempt === MAX_CODE_ATTEMPTS) throw error;
    }
  }

  throw ApiError.internal('Could not generate a unique referral code. Please try again.');
}

/**
 * List all referral codes (Admin only).
 *
 * The names are the point. Without them the list answers "was this code used?"
 * and not "who did we let in with it?", which is the only question worth
 * keeping a spent code around for.
 *
 * Both relations are optional: an account that has since been deleted leaves
 * the row intact with nothing to name it, and the caller renders that honestly
 * rather than treating it as an error.
 */
export async function listReferralCodes() {
  return prisma.referralCode.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      creator: { select: { name: true, email: true } },
      user: {
        select: {
          name: true,
          email: true,
          shop: { select: { name: true } },
        },
      },
    },
  });
}

/**
 * Revoke or delete a referral code that was never redeemed (Admin only).
 *
 * Guarded on `usedAt` rather than `usedBy` for the same reason redemption is:
 * `usedBy` clears when the owner's account is deleted, and that must not turn
 * a spent code into a deletable one. A used code is the record of how that
 * shop owner got in and is not an admin's to remove.
 */
export async function deleteReferralCode(codeId: string) {
  const result = await prisma.referralCode.deleteMany({
    where: { id: codeId, usedAt: null }
  });

  if (result.count === 0) {
    throw ApiError.badRequest('Code not found or has already been used.');
  }
  return true;
}

/**
 * How long an expired, never-redeemed code stays visible before it is swept.
 *
 * Deleting at the moment of expiry would erase the evidence that a code was
 * issued and went unused, which is exactly what an admin wants to see when
 * chasing a shop owner who never finished registering. A month is long enough
 * to notice and short enough that the table does not accumulate dead rows.
 */
export const EXPIRED_CODE_GRACE_DAYS = 30;

/**
 * Delete codes that expired without ever being redeemed.
 *
 * Only ever unused codes: a redeemed code is the audit record of which admin
 * authorised which shop owner and is never swept, no matter how old. Codes
 * with no expiry are skipped rather than treated as expired — `expiresAt` is
 * nullable and null means "never", not "long ago".
 */
export async function sweepExpiredReferralCodes(): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - EXPIRED_CODE_GRACE_DAYS);

  const result = await prisma.referralCode.deleteMany({
    where: {
      usedAt: null,
      expiresAt: { not: null, lt: cutoff },
    },
  });

  return result.count;
}
