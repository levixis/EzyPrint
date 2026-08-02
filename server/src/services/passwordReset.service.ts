import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { issueOtp, consumeOtp } from './otp.service';
import { sendPasswordResetEmail } from './email.service';

/**
 * Password reset by emailed one-time code.
 *
 * Until this existed a forgotten password meant a permanently lost account:
 * there was no reset endpoint anywhere, and the only way back in was the
 * accidental one in `loginWithGoogle`, which matches an existing account by
 * verified email and so lets a Google user sign in past their own forgotten
 * password. That covers people whose address is a Google account and nobody
 * else — including the shop owners, who are the accounts holding money.
 *
 * A six-digit code rather than a reset link. The app ships as a Capacitor
 * Android build as well as a web app, and a link in an email opens the phone's
 * browser, not the app — so a link would need deep-link plumbing and a hosted
 * landing page to serve one flow, while a code the user types works identically
 * everywhere with no extra surface. It also reuses `otp.service`, which is
 * already hardened where it counts: codes stored hashed, single-use via one
 * atomic conditional DELETE, three wrong guesses then a fifteen-minute lockout.
 *
 * Accounts that have only ever signed in with Google are allowed through as
 * well, which sets a password where there was none. That grants nothing new: a
 * reset code is delivered to the inbox, and anyone holding the inbox already
 * controls the Google account this address signs in with. Refusing them would
 * mean answering differently depending on how an account authenticates, which
 * is exactly the disclosure the uniform responses below exist to prevent.
 */

/** Scope for `otp.service`. Distinct from the `payout_*` / `refund_*` actions. */
const RESET_ACTION = 'password_reset';

/** Matches SALT_ROUNDS in auth.service — a reset must not produce a weaker hash. */
const SALT_ROUNDS = 12;

/**
 * The error shown for every failure that would otherwise distinguish "no such
 * account" from "no code was issued". Reset is an unauthenticated endpoint, so
 * a distinct "user not found" turns it into an account-existence oracle.
 */
const NO_CODE = 'No verification code was requested for this email.';

/**
 * Begin a reset. Emails a code if the address belongs to an account.
 *
 * Resolves the same way whether or not the account exists, and the caller
 * answers 200 either way — otherwise anyone could enumerate which of 30,000
 * campus addresses are registered by watching this endpoint's status codes.
 *
 * A delivery failure is deliberately not surfaced either, for the same reason:
 * "we could not send mail to that address" is the same disclosure by another
 * route. It is logged so the failure is visible to us rather than to the caller.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true },
  });

  if (!user?.email) return;

  let code: string;
  try {
    code = await issueOtp(user.id, RESET_ACTION);
  } catch {
    // issueOtp throws while the account is locked out from earlier wrong
    // guesses. Staying silent keeps the response uniform; the lockout is
    // reported honestly when they submit a code.
    return;
  }

  try {
    await sendPasswordResetEmail(user.email, code, user.name);
  } catch (error) {
    console.error(
      `[password-reset] could not email a code to user ${user.id}:`,
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Complete a reset: verify the code, set the new password, end every session.
 *
 * Revoking sessions is the half that is easy to leave out and expensive to
 * omit. Someone resets their password precisely because they suspect another
 * person has it, and an attacker signed in on their own device holds a refresh
 * token that keeps working indefinitely regardless of the new password. The
 * write and the revocation share a transaction so a crash between them cannot
 * leave the password changed and the intruder's session alive.
 */
export async function resetPassword(
  email: string,
  code: string,
  newPassword: string
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  // Deliberately the message consumeOtp gives for an account that never
  // requested one, so the two cases are indistinguishable from outside.
  if (!user) throw ApiError.badRequest(NO_CODE);

  // Throws on a wrong, expired, missing or locked-out code. On success the code
  // is gone, so a replay of the same value cannot set the password twice.
  await consumeOtp(user.id, RESET_ACTION, code);

  const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { password: hashed },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: user.id, isRevoked: false },
      data: { isRevoked: true },
    }),
  ]);
}
