import crypto from 'crypto';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';

/**
 * One-time verification codes for sensitive actions (payout approval, account
 * deletion, shop archival).
 *
 * Codes are stored hashed and are strictly single-use: consumption is a single
 * atomic DELETE conditioned on the code itself, so two requests carrying the
 * same code can never both succeed. A read-then-compare-then-delete would let
 * concurrent requests both pass the comparison before either delete landed and
 * execute the guarded action twice — which for a payout means paying twice.
 */

export const OTP_TTL_MS = 5 * 60 * 1000;

/**
 * The same window, phrased for the email that carries the code.
 *
 * `email.service` hardcoded "5 minutes" in both the text and the HTML body, so
 * changing the TTL here would have left the mail confidently stating the old
 * one. Exported so there is a single source for the number and the sentence.
 */
export const OTP_TTL_LABEL = `${OTP_TTL_MS / 60000} minutes`;
const MAX_FAILED_ATTEMPTS = 3;
const LOCKOUT_MS = 15 * 60 * 1000;

/** Sentinel stored in place of the hash once an account is locked out. */
const LOCKED_SENTINEL = 'LOCKED';

function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

/**
 * Issue a code for `actionId`, replacing any previous one for the same
 * user+action. Returns the plaintext code for delivery — it is not recoverable
 * afterwards.
 */
export async function issueOtp(userId: string, actionId: string): Promise<string> {
  const existing = await prisma.adminOtp.findUnique({
    where: { userId_actionId: { userId, actionId } },
  });

  if (existing?.lockUntil && existing.lockUntil > new Date()) {
    const seconds = Math.ceil((existing.lockUntil.getTime() - Date.now()) / 1000);
    throw ApiError.tooManyRequests(`Too many failed attempts. Try again in ${seconds}s.`);
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.adminOtp.upsert({
    where: { userId_actionId: { userId, actionId } },
    create: { userId, actionId, otp: hashOtp(otp), expiresAt, failedAttempts: 0 },
    update: { otp: hashOtp(otp), expiresAt, failedAttempts: 0, lockUntil: null },
  });

  return otp;
}

/**
 * Verify and consume a code. Throws if it is missing, wrong, expired or locked.
 *
 * On success the code is gone, so a replay of the same value fails.
 */
export async function consumeOtp(userId: string, actionId: string, otp: string): Promise<void> {
  if (!otp || typeof otp !== 'string') {
    throw ApiError.badRequest('A verification code is required for this action.');
  }

  const now = new Date();

  // The claim: matching row is deleted in one statement, so exactly one caller
  // can win it. `count === 1` is proof this request consumed the code.
  const claimed = await prisma.adminOtp.deleteMany({
    where: {
      userId,
      actionId,
      otp: hashOtp(otp),
      expiresAt: { gt: now },
      OR: [{ lockUntil: null }, { lockUntil: { lt: now } }],
    },
  });

  if (claimed.count === 1) return;

  // Failed. Work out why, and charge the attempt.
  const record = await prisma.adminOtp.findUnique({
    where: { userId_actionId: { userId, actionId } },
  });

  if (!record) {
    throw ApiError.badRequest('No verification code was requested for this action.');
  }

  if (record.lockUntil && record.lockUntil > now) {
    const seconds = Math.ceil((record.lockUntil.getTime() - now.getTime()) / 1000);
    throw ApiError.tooManyRequests(`Too many failed attempts. Try again in ${seconds}s.`);
  }

  if (record.expiresAt < now) {
    await prisma.adminOtp.deleteMany({ where: { id: record.id } });
    throw ApiError.badRequest('Verification code expired. Please request a new one.');
  }

  // Wrong code. Increment atomically so concurrent guesses all count.
  const updated = await prisma.adminOtp.update({
    where: { id: record.id },
    data: { failedAttempts: { increment: 1 } },
  });

  if (updated.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    await prisma.adminOtp.update({
      where: { id: record.id },
      data: { lockUntil: new Date(Date.now() + LOCKOUT_MS), otp: LOCKED_SENTINEL },
    });
    throw ApiError.tooManyRequests('Locked out for 15 minutes due to repeated failures.');
  }

  const remaining = MAX_FAILED_ATTEMPTS - updated.failedAttempts;
  throw ApiError.badRequest(`Invalid verification code. ${remaining} attempt(s) remaining.`);
}

/**
 * Delete verification codes nobody used.
 *
 * A code is removed when it is consumed, and when an expired one is presented —
 * but a code that is issued and simply never used is removed by nothing. The
 * `@@unique([userId, actionId])` pair bounds this per user *per action*, and the
 * action ids that matter are per record (`payout_<id>`, `refund_<id>`), so the
 * table grows with payout and refund volume rather than with user count.
 *
 * Only rows past their expiry, so a live code is never taken from under someone
 * mid-verification. A lockout row is kept until `lockUntil` passes as well —
 * deleting it early would hand a locked-out caller a clean slate.
 */
export async function sweepExpiredOtps(now: Date = new Date()): Promise<number> {
  const result = await prisma.adminOtp.deleteMany({
    where: {
      expiresAt: { lt: now },
      OR: [{ lockUntil: null }, { lockUntil: { lt: now } }],
    },
  });
  return result.count;
}
