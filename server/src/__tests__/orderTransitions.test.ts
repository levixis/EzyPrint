/**
 * Unit Tests — who may drive which order transition.
 *
 * These rules are the access control on the order lifecycle. Before they
 * existed, any authenticated student could drive any order by id, including
 * READY_FOR_PICKUP -> COMPLETED, which credits a shop's ledger with real money.
 */

import { canRoleTransition } from '../services/order.service';

describe('Order transition permissions', () => {
  describe('student', () => {
    test('can cancel before the shop has started printing', () => {
      expect(canRoleTransition('STUDENT', 'PENDING_PAYMENT', 'CANCELLED')).toBe(true);
      expect(canRoleTransition('STUDENT', 'PENDING_APPROVAL', 'CANCELLED')).toBe(true);
    });

    test('cannot cancel once printing has started', () => {
      // Paper and toner are already spent by this point.
      expect(canRoleTransition('STUDENT', 'PRINTING', 'CANCELLED')).toBe(false);
      expect(canRoleTransition('STUDENT', 'READY_FOR_PICKUP', 'CANCELLED')).toBe(false);
    });

    test('cannot mark an order complete, which is what credits the shop', () => {
      expect(canRoleTransition('STUDENT', 'READY_FOR_PICKUP', 'COMPLETED')).toBe(false);
    });

    test('cannot start printing on the shop’s behalf', () => {
      expect(canRoleTransition('STUDENT', 'PENDING_APPROVAL', 'PRINTING')).toBe(false);
    });
  });

  describe('shop owner', () => {
    test('keeps an escape hatch at every stage', () => {
      // A jammed printer or unreadable file has to be resolvable without an admin.
      expect(canRoleTransition('SHOP_OWNER', 'PENDING_APPROVAL', 'CANCELLED')).toBe(true);
      expect(canRoleTransition('SHOP_OWNER', 'PRINTING', 'CANCELLED')).toBe(true);
      expect(canRoleTransition('SHOP_OWNER', 'READY_FOR_PICKUP', 'CANCELLED')).toBe(true);
    });

    test('drives the fulfilment path', () => {
      expect(canRoleTransition('SHOP_OWNER', 'PENDING_APPROVAL', 'PRINTING')).toBe(true);
      expect(canRoleTransition('SHOP_OWNER', 'PRINTING', 'READY_FOR_PICKUP')).toBe(true);
      expect(canRoleTransition('SHOP_OWNER', 'READY_FOR_PICKUP', 'COMPLETED')).toBe(true);
    });

    test('cannot resurrect a terminal order', () => {
      expect(canRoleTransition('SHOP_OWNER', 'CANCELLED', 'PRINTING')).toBe(false);
      expect(canRoleTransition('SHOP_OWNER', 'COMPLETED', 'PRINTING')).toBe(false);
    });
  });

  describe('admin', () => {
    test('may make any legal transition', () => {
      expect(canRoleTransition('ADMIN', 'PRINTING', 'CANCELLED')).toBe(true);
      expect(canRoleTransition('ADMIN', 'COMPLETED', 'REFUNDED')).toBe(true);
    });

    test('is still bound by what is legal at all', () => {
      // Terminal means terminal, even for an admin.
      expect(canRoleTransition('ADMIN', 'CANCELLED', 'COMPLETED')).toBe(false);
      expect(canRoleTransition('ADMIN', 'REFUNDED', 'PRINTING')).toBe(false);
    });
  });
});

describe('Failed payment is a dead end no longer', () => {
  test('a student can cancel an order whose payment failed', () => {
    // Nothing was ever charged, so there is nothing to refund. Previously
    // PAYMENT_FAILED could only go back to PENDING_PAYMENT, trapping the order
    // in a retry loop that not even an admin could clear.
    expect(canRoleTransition('STUDENT', 'PAYMENT_FAILED', 'CANCELLED')).toBe(true);
  });

  test('retrying payment still works', () => {
    expect(canRoleTransition('STUDENT', 'PAYMENT_FAILED', 'PENDING_PAYMENT')).toBe(true);
  });

  test('an admin can clear one too', () => {
    expect(canRoleTransition('ADMIN', 'PAYMENT_FAILED', 'CANCELLED')).toBe(true);
  });

  test('a failed payment cannot jump straight to fulfilment', () => {
    expect(canRoleTransition('STUDENT', 'PAYMENT_FAILED', 'COMPLETED')).toBe(false);
    expect(canRoleTransition('SHOP_OWNER', 'PAYMENT_FAILED', 'PRINTING')).toBe(false);
  });
});
