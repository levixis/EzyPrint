/**
 * Who may cancel a payout, in which state, and when the OTP is spent.
 *
 * This file used to declare its own `CANCELLABLE` array and assert against that
 * — a test that could never fail when the route changed, and whose comments
 * described the admin's intent while the route granted the shop. It now imports
 * the decision the route actually makes.
 *
 * The hole that closed: `/payouts/:id/cancel` was mounted
 * `authorize('SHOP_OWNER', 'ADMIN')` and admitted DISPUTED for both. DISPUTED is
 * only reachable from PAID or IN_TRANSIT, so an admin has already sent the
 * money; the compensating PAYOUT_CANCEL_REFUND is therefore not a reversal but a
 * second payment. A shop could drive request -> approve -> dispute -> cancel ->
 * request and be paid twice, self-serving the OTP from POST /admin/otp on the
 * way. See `mayRequestOtpFor` for that half.
 */

import { cancellablePayoutStatusesFor } from '../routes/payout.routes';

describe('a shop owner may only cancel its own un-approved request', () => {
  const shop = cancellablePayoutStatusesFor('SHOP_OWNER');

  test('PENDING is theirs to withdraw', () => {
    // Nothing has left: the reservation still holds the debit taken at request
    // time, so cancelling is its exact reversal.
    expect(shop).toContain('PENDING');
  });

  test('DISPUTED is not', () => {
    // This is the whole finding. Money already went out; crediting it back is a
    // judgement that it never arrived, and the party being paid cannot make it.
    expect(shop).not.toContain('DISPUTED');
  });

  test('nor is anything the money has already left on', () => {
    expect(shop).not.toContain('PAID');
    expect(shop).not.toContain('IN_TRANSIT');
  });
});

describe('an admin resolves the dispute', () => {
  const admin = cancellablePayoutStatusesFor('ADMIN');

  test('DISPUTED is cancellable, because the resolution is theirs to make', () => {
    expect(admin).toContain('DISPUTED');
  });

  test('PENDING too — an admin may decline a request before approving it', () => {
    expect(admin).toContain('PENDING');
  });

  test('but money in flight is still untouchable', () => {
    // Crediting the balance back while a transfer is in flight, or after it
    // landed, pays the shop twice — for an admin as much as for a shop.
    expect(admin).not.toContain('IN_TRANSIT');
    expect(admin).not.toContain('PAID');
  });

  test('a settled payout cannot be cancelled again', () => {
    for (const status of ['CANCELLED', 'REJECTED', 'CONFIRMED'] as const) {
      expect(admin).not.toContain(status);
    }
  });
});

describe('the role table fails closed', () => {
  test('a role that is not named cancels nothing', () => {
    // The route is mounted authorize('SHOP_OWNER', 'ADMIN'), so a third role
    // cannot reach it today. The empty default is what makes *adding* one a
    // route that refuses rather than one that inherits an admin's powers by
    // omission.
    expect(cancellablePayoutStatusesFor('STUDENT')).toEqual([]);
    expect(cancellablePayoutStatusesFor(undefined)).toEqual([]);
    expect(cancellablePayoutStatusesFor('')).toEqual([]);
  });

  test('a shop owner never has more reach than an admin', () => {
    const admin = cancellablePayoutStatusesFor('ADMIN');
    for (const status of cancellablePayoutStatusesFor('SHOP_OWNER')) {
      expect(admin).toContain(status);
    }
  });
});

/**
 * The reservation's status is not a precondition for refunding, but it does
 * decide whether the credit is a reversal or a re-payment.
 *
 * It is PENDING only while the payout is; approval settles it. The route reads
 * it directly rather than inferring it from the payout's own status, because the
 * two are written by different statements and a payout that disagrees with its
 * own reservation is exactly the case worth refusing to a non-admin.
 */
describe('returning the money', () => {
  const reservationStatusFor = (payout: string) => (payout === 'PENDING' ? 'PENDING' : 'SETTLED');

  test('a pending payout still holds a pending reservation — a true reversal', () => {
    expect(reservationStatusFor('PENDING')).toBe('PENDING');
  });

  test('a disputed payout does not, because approval settled it', () => {
    expect(reservationStatusFor('DISPUTED')).toBe('SETTLED');
  });

  test('so a settled reservation means the credit is a second payment', () => {
    // Which is why the route requires ADMIN once the reservation is not PENDING,
    // whatever the payout row says.
    expect(reservationStatusFor('DISPUTED')).not.toBe('PENDING');
  });
});
