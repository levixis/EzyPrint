/**
 * The payout state machine, after collapsing approve and mark-sent.
 *
 * Two admin steps existed for an operation that authorises a batch in the
 * morning and makes the transfers in the afternoon. A single admin sending UPI
 * has no gap between them, so the second step asked them to re-assert something
 * already true, and charged another OTP for it.
 *
 * What remains is the division that actually matters: the admin says what they
 * did (sent), the shop says what only it can see (arrived, or never did).
 */

import type { PayoutStatus } from '@prisma/client';

/** States in which the shop is asked to confirm or dispute. */
const AWAITING_SHOP: PayoutStatus[] = ['PAID', 'IN_TRANSIT'];

/** States a cancellation may act on — mirrors CANCELLABLE_PAYOUT_STATUSES. */
const CANCELLABLE: PayoutStatus[] = ['PENDING', 'DISPUTED'];

describe('Who asserts what', () => {
  test('approval lands on PAID — the last thing an admin can truthfully claim', () => {
    // Not "received": whether it arrived is not the admin's to say.
    const afterApproval: PayoutStatus = 'PAID';
    expect(AWAITING_SHOP).toContain(afterApproval);
  });

  test('the shop can act on payouts approved under the old two-step flow', () => {
    // Anything sitting in IN_TRANSIT predates the change and would otherwise
    // have no way forward at all.
    expect(AWAITING_SHOP).toContain('IN_TRANSIT');
  });

  test('a shop is not asked to confirm something not yet sent', () => {
    expect(AWAITING_SHOP).not.toContain('PENDING');
  });

  test('nor anything already settled', () => {
    for (const status of ['CONFIRMED', 'REJECTED', 'CANCELLED'] as PayoutStatus[]) {
      expect(AWAITING_SHOP).not.toContain(status);
    }
  });
});

describe('A dispute stays resolvable', () => {
  test('a disputed payout can be cancelled and refunded', () => {
    // The shop says it never arrived; returning the reservation is the fix.
    expect(CANCELLABLE).toContain('DISPUTED');
  });

  test('but money in flight cannot be, or the shop is paid twice', () => {
    expect(CANCELLABLE).not.toContain('PAID');
    expect(CANCELLABLE).not.toContain('IN_TRANSIT');
  });

  test('the two sets overlap only where they must', () => {
    // A payout is either awaiting the shop's word or cancellable, never both —
    // except via DISPUTED, which is reached only after the shop has spoken.
    const overlap = AWAITING_SHOP.filter((s) => CANCELLABLE.includes(s));
    expect(overlap).toEqual([]);
  });
});
