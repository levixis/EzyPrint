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
 * List all referral codes (Admin only)
 */
export async function listReferralCodes() {
  // We didn't define relations in schema.prisma for creator and user, so we'll fetch them separately or join manually if needed.
  // Wait, I should just return the raw codes for now, or update the schema to add relations. Let's return raw codes.
  const codes = await prisma.referralCode.findMany({
    orderBy: { createdAt: 'desc' },
  });

  return codes;
}

/**
 * Revoke or delete an unused referral code (Admin only)
 */
export async function deleteReferralCode(codeId: string) {
  const result = await prisma.referralCode.deleteMany({
    where: { id: codeId, usedBy: null }
  });

  if (result.count === 0) {
    throw ApiError.badRequest('Code not found or has already been used.');
  }
  return true;
}
