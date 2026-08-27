/**
 * Who may have the server mail them a one-time code.
 *
 * `POST /api/v1/admin/otp` was mounted `authenticate` with no `authorize`, and
 * the action id regex accepts `payout_<id>`, `refund_<id>` and
 * `reactivation_<id>` for any id in the system, plus DELETE_USER and
 * ARCHIVE_USER. So any signed-in student or shop owner could obtain a live code
 * for any of them, delivered to their own mailbox.
 *
 * On its own that was mostly noise: the admin-only consumers re-check the role.
 * What made it matter is that `consumeOtp` is keyed on `(userId, actionId)` and
 * `/payouts/:id/cancel` accepts a SHOP_OWNER — so the shop owner's self-issued
 * `payout_<id>` code was exactly the credential that route wanted. A step-up
 * factor the first factor can mint for itself is not a second factor.
 */

const mockPayoutFindUnique = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: { payout: { findUnique: mockPayoutFindUnique } },
}));

import { mayRequestOtpFor } from '../routes/admin.routes';
import { otpActionId } from '../validators/schemas';

const admin = { id: 'admin_1', type: 'ADMIN' };
const owner = { id: 'owner_1', type: 'SHOP_OWNER' };
const student = { id: 'student_1', type: 'STUDENT' };

beforeEach(() => {
  jest.clearAllMocks();
  mockPayoutFindUnique.mockResolvedValue(null);
});

/** A payout belonging to `ownerUserId`. */
const payoutOwnedBy = (ownerUserId: string) => ({ shop: { ownerUserId } });

describe('acting on your own account needs only a session', () => {
  test.each(['DELETE_OWN_ACCOUNT', 'ARCHIVE_OWN_SHOP'])('%s is open to anyone signed in', async (action) => {
    expect(await mayRequestOtpFor(student, action)).toBe(true);
    expect(await mayRequestOtpFor(owner, action)).toBe(true);
  });
});

describe('admin actions are for admins', () => {
  test.each([
    'DELETE_USER',
    'ARCHIVE_USER',
    'refund_abc123',
    'reactivation_abc123',
  ])('%s is refused to a student', async (action) => {
    expect(await mayRequestOtpFor(student, action)).toBe(false);
  });

  test.each([
    'DELETE_USER',
    'ARCHIVE_USER',
    'refund_abc123',
    'reactivation_abc123',
  ])('%s is refused to a shop owner', async (action) => {
    expect(await mayRequestOtpFor(owner, action)).toBe(false);
  });

  test('an admin may request any of them', async () => {
    for (const action of ['DELETE_USER', 'ARCHIVE_USER', 'refund_abc123', 'reactivation_abc123', 'payout_abc123']) {
      expect(await mayRequestOtpFor(admin, action)).toBe(true);
    }
  });
});

describe('payout codes are scoped to the payout', () => {
  test('a shop owner may request one for their own payout', async () => {
    // The one legitimate non-admin case: cancelling a PENDING request of their
    // own. See payoutCancel.test.ts for what that cancel is allowed to touch.
    mockPayoutFindUnique.mockResolvedValue(payoutOwnedBy('owner_1'));

    expect(await mayRequestOtpFor(owner, 'payout_p1')).toBe(true);
  });

  test('but not for another shop’s payout', async () => {
    mockPayoutFindUnique.mockResolvedValue(payoutOwnedBy('owner_2'));

    expect(await mayRequestOtpFor(owner, 'payout_p1')).toBe(false);
  });

  test('and not for a payout id that names nothing', async () => {
    // Same refusal as "not yours", deliberately: a caller must not be able to
    // enumerate which payout ids exist by watching which ones answer differently.
    mockPayoutFindUnique.mockResolvedValue(null);

    expect(await mayRequestOtpFor(owner, 'payout_nope')).toBe(false);
  });

  test('a student may not request one at all, even for a real payout', async () => {
    mockPayoutFindUnique.mockResolvedValue(payoutOwnedBy('student_1'));

    expect(await mayRequestOtpFor(student, 'payout_p1')).toBe(false);
  });

  test('the ownership check is not skipped — the payout is actually looked up', async () => {
    mockPayoutFindUnique.mockResolvedValue(payoutOwnedBy('owner_1'));

    await mayRequestOtpFor(owner, 'payout_p1');

    expect(mockPayoutFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p1' } })
    );
  });
});

describe('the action id vocabulary this gate has to cover', () => {
  // If the schema starts accepting a new kind of action, this gate has to grow a
  // branch for it. The test exists so that adding one without deciding who owns
  // it fails here rather than defaulting to somebody's inbox.
  const KNOWN = [
    'DELETE_USER',
    'ARCHIVE_USER',
    'DELETE_OWN_ACCOUNT',
    'ARCHIVE_OWN_SHOP',
    'refund_x',
    'payout_x',
    'reactivation_x',
  ];

  test('every accepted action id is one of the shapes above', () => {
    for (const action of KNOWN) {
      expect(otpActionId.safeParse(action).success).toBe(true);
    }
  });

  test('nothing outside them parses', () => {
    for (const action of ['DROP_TABLE', 'payout', 'refund_', 'admin_x', '../../etc']) {
      expect(otpActionId.safeParse(action).success).toBe(false);
    }
  });

  test('a shop owner is refused every admin-owned shape', async () => {
    const adminOwned = KNOWN.filter((a) => !a.endsWith('_OWN_ACCOUNT') && !a.endsWith('_OWN_SHOP') && !a.startsWith('payout_'));

    for (const action of adminOwned) {
      expect(await mayRequestOtpFor(owner, action)).toBe(false);
    }
  });
});
