/**
 * Password reset.
 *
 * Before this existed a forgotten password meant a permanently lost account —
 * no reset endpoint, no link on the login screen. The only way back was the
 * accidental one in `loginWithGoogle`, which matches by verified email and so
 * happens to let a Google user in past their own forgotten password. That
 * covers people on a Google address and nobody else, including the shop owners,
 * who are the accounts holding money.
 *
 * The two properties worth defending here are the ones that are easy to write
 * and easy to get subtly wrong: that the endpoint never reveals which addresses
 * are registered, and that a reset ends every existing session.
 */

const mockUserFindUnique = jest.fn();
const mockUserFindFirst = jest.fn();
const mockUserUpdate = jest.fn();
const mockTokenUpdateMany = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
      // Email lookups fall back to a case-insensitive match when the exact
      // form is not stored, so that an address registered as `Name@gmail.com`
      // can still request and use a reset code typed in lower case.
      findFirst: (...a: unknown[]) => mockUserFindFirst(...a),
      update: (...a: unknown[]) => mockUserUpdate(...a),
    },
    refreshToken: { updateMany: (...a: unknown[]) => mockTokenUpdateMany(...a) },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

const mockIssueOtp = jest.fn();
const mockConsumeOtp = jest.fn();
jest.mock('../services/otp.service', () => ({
  issueOtp: (...a: unknown[]) => mockIssueOtp(...a),
  consumeOtp: (...a: unknown[]) => mockConsumeOtp(...a),
}));

const mockSendResetEmail = jest.fn();
jest.mock('../services/email.service', () => ({
  sendPasswordResetEmail: (...a: unknown[]) => mockSendResetEmail(...a),
}));

import { requestPasswordReset, resetPassword } from '../services/passwordReset.service';

const USER = { id: 'user_1', email: 'student@campus.edu', name: 'Asha' };

beforeEach(() => {
  jest.clearAllMocks();
  mockUserFindUnique.mockResolvedValue(USER);
  // No case-variant row unless a test says otherwise: the exact match answers.
  mockUserFindFirst.mockResolvedValue(null);
  mockIssueOtp.mockResolvedValue('123456');
  mockSendResetEmail.mockResolvedValue(undefined);
  mockConsumeOtp.mockResolvedValue(undefined);
  mockTransaction.mockResolvedValue([]);
});

describe('Requesting a code says nothing about who is registered', () => {
  test('an unknown address is accepted silently and sends no mail', async () => {
    mockUserFindUnique.mockResolvedValue(null);

    await expect(requestPasswordReset('stranger@nowhere.com')).resolves.toBeUndefined();
    expect(mockIssueOtp).not.toHaveBeenCalled();
    expect(mockSendResetEmail).not.toHaveBeenCalled();
  });

  test('a known address resolves the same way, having sent a code', async () => {
    // Identical resolution to the case above is the whole point: the caller
    // cannot tell the two apart, so this cannot be used to enumerate which of
    // 30,000 campus addresses have accounts.
    await expect(requestPasswordReset(USER.email)).resolves.toBeUndefined();
    expect(mockSendResetEmail).toHaveBeenCalledWith(USER.email, '123456', USER.name);
  });

  test('a mail delivery failure is swallowed rather than reported', async () => {
    // "We could not send to that address" is the same disclosure by another
    // route, and would also hand the caller a way to probe our mail provider.
    mockSendResetEmail.mockRejectedValue(new Error('Resend returned 403'));

    await expect(requestPasswordReset(USER.email)).resolves.toBeUndefined();
  });

  test('a lockout from earlier wrong guesses does not leak either', async () => {
    mockIssueOtp.mockRejectedValue(new Error('Too many failed attempts. Try again in 600s.'));

    await expect(requestPasswordReset(USER.email)).resolves.toBeUndefined();
    expect(mockSendResetEmail).not.toHaveBeenCalled();
  });

  test('an account row with no email address is skipped', async () => {
    // Google accounts always carry one, but the column is nullable and a null
    // would otherwise reach the mailer as a recipient.
    mockUserFindUnique.mockResolvedValue({ id: 'user_2', email: null, name: 'X' });

    await expect(requestPasswordReset('whatever@x.com')).resolves.toBeUndefined();
    expect(mockSendResetEmail).not.toHaveBeenCalled();
  });
});

describe('Submitting a code', () => {
  test('an unknown address fails with the wording used for no-code-requested', async () => {
    mockUserFindUnique.mockResolvedValue(null);

    await expect(resetPassword('stranger@nowhere.com', '123456', 'NewPass1!')).rejects.toThrow(
      /No verification code was requested/
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test('a rejected code stops the reset before anything is written', async () => {
    mockConsumeOtp.mockRejectedValue(new Error('Invalid verification code. 2 attempt(s) remaining.'));

    await expect(resetPassword(USER.email, '000000', 'NewPass1!')).rejects.toThrow(/Invalid verification/);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test('the code is consumed under the reset scope, not a payout scope', async () => {
    await resetPassword(USER.email, '123456', 'NewPass1!');

    expect(mockConsumeOtp).toHaveBeenCalledWith(USER.id, 'password_reset', '123456');
  });

  test('the stored password is a hash, never the plaintext', async () => {
    await resetPassword(USER.email, '123456', 'NewPass1!');

    const stored = mockUserUpdate.mock.calls[0][0].data.password;
    expect(stored).not.toBe('NewPass1!');
    expect(stored).toMatch(/^\$2[aby]\$/); // bcrypt
  });
});

describe('A reset ends every existing session', () => {
  test('refresh tokens are revoked alongside the password write', async () => {
    // The reason someone resets is that they think another person has their
    // password. That person is signed in on their own device holding a refresh
    // token, which keeps working forever regardless of the new password unless
    // this happens.
    await resetPassword(USER.email, '123456', 'NewPass1!');

    expect(mockTokenUpdateMany).toHaveBeenCalledWith({
      where: { userId: USER.id, isRevoked: false },
      data: { isRevoked: true },
    });
  });

  test('the password change and the revocation share one transaction', async () => {
    // Split across two round trips, a crash in between leaves the password
    // changed and the intruder's session alive — the worst of both.
    await resetPassword(USER.email, '123456', 'NewPass1!');

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTransaction.mock.calls[0][0]).toHaveLength(2);
  });
});
