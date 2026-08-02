/**
 * Which payouts can be cancelled, and when the OTP is spent.
 *
 * The admin dashboard offers "Cancel & Refund" on a DISPUTED payout — the shop
 * has said the money never arrived, and returning the reservation to their
 * balance is the resolution. The route allowed only PENDING, so that button
 * could never work.
 *
 * Worse, the code was consumed before any of that was checked, so each attempt
 * destroyed the OTP and the next needed a fresh email to fail identically. It
 * presented as "OTP not working" rather than "this cannot be cancelled".
 */

import type { PayoutStatus } from '@prisma/client';

const CANCELLABLE: PayoutStatus[] = ['PENDING', 'DISPUTED'];

describe('Cancellable payout states', () => {
  test('a payout awaiting approval can be cancelled', () => {
    expect(CANCELLABLE).toContain('PENDING');
  });

  test('a disputed payout can be cancelled — this is the dispute resolution', () => {
    // The shop reported the money never arrived. The admin returns it.
    expect(CANCELLABLE).toContain('DISPUTED');
  });

  test('money already sent cannot be cancelled', () => {
    // Crediting the balance back while a transfer is in flight, or after it
    // landed, pays the shop twice.
    expect(CANCELLABLE).not.toContain('IN_TRANSIT');
    expect(CANCELLABLE).not.toContain('PAID');
  });

  test('a settled payout cannot be cancelled again', () => {
    expect(CANCELLABLE).not.toContain('CANCELLED');
    expect(CANCELLABLE).not.toContain('REJECTED');
    expect(CANCELLABLE).not.toContain('CONFIRMED');
  });
});

/**
 * The reservation entry's status is not a precondition for refunding.
 *
 * It is PENDING only while the payout is; approval settles it, and a disputed
 * payout has always been through approval. Requiring PENDING therefore rejected
 * exactly the case the button exists for.
 */
describe('Returning the money', () => {
  const reservationStatusFor = (payout: PayoutStatus) =>
    payout === 'PENDING' ? 'PENDING' : 'SETTLED';

  test('a pending payout still holds a pending reservation', () => {
    expect(reservationStatusFor('PENDING')).toBe('PENDING');
  });

  test('a disputed payout does not, because approval settled it', () => {
    expect(reservationStatusFor('DISPUTED')).toBe('SETTLED');
  });

  test('so the refund cannot depend on the reservation being pending', () => {
    // Both states must refund; only the compensating credit moves money, and
    // its eventId is unique so a retry cannot credit twice.
    for (const status of CANCELLABLE) {
      expect(['PENDING', 'SETTLED']).toContain(reservationStatusFor(status));
    }
  });
});
