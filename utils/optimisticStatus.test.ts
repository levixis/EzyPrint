import { describe, test, expect } from 'vitest';
import { OrderStatus } from '../types';
import { applyOverrides, retireConfirmedOverrides, type StatusOverrides } from './optimisticStatus';

/**
 * The overlay that makes a shop owner's tap register before the round trip.
 *
 * Its whole safety property is that it is drawn *over* the server's orders and
 * never written into them, so nothing has to be reconciled when a change fails.
 * These pin the two halves: what an override shows, and when it stops.
 */

const order = (id: string, status: OrderStatus) => ({ id, status });

const pending = (from: OrderStatus, to: OrderStatus): StatusOverrides['x'] => ({ from, to });

describe('applying overrides', () => {
  test('shows the pending status instead of the confirmed one', () => {
    const result = applyOverrides(
      [order('o1', OrderStatus.PENDING_APPROVAL)],
      { o1: pending(OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING) }
    );

    expect(result[0].status).toBe(OrderStatus.PRINTING);
  });

  test('leaves orders with no override untouched', () => {
    const orders = [order('o1', OrderStatus.PRINTING), order('o2', OrderStatus.COMPLETED)];
    const result = applyOverrides(orders, {
      o1: pending(OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING),
    });

    expect(result[1]).toBe(orders[1]); // same reference, no needless rerender
  });

  test('an override matching the server is not applied', () => {
    // It has nothing to say, which is what lets a matured override sit
    // harmlessly between the fetch that confirmed it and its retirement.
    const orders = [order('o1', OrderStatus.PRINTING)];
    const result = applyOverrides(orders, {
      o1: pending(OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING),
    });

    expect(result[0]).toBe(orders[0]);
  });

  test('does not mutate the orders it was given', () => {
    const orders = [order('o1', OrderStatus.PENDING_APPROVAL)];
    applyOverrides(orders, { o1: pending(OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING) });

    expect(orders[0].status).toBe(OrderStatus.PENDING_APPROVAL);
  });
});

describe('retiring overrides', () => {
  test('drops an override once the server reports the change', () => {
    const next = retireConfirmedOverrides(
      { o1: pending(OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING) },
      [order('o1', OrderStatus.PRINTING)]
    );

    expect(next).toEqual({});
  });

  /**
   * The reversion case. The refetch that followed the change may be superseded
   * by a newer one and publish nothing, leaving `rawOrders` still on the old
   * status. Retiring then would show the shop owner their own tap undoing
   * itself, which is the exact thing the overlay exists to prevent.
   */
  test('keeps an override while the server still shows the old status', () => {
    const overrides = { o1: pending(OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING) };
    const next = retireConfirmedOverrides(
      overrides,
      [order('o1', OrderStatus.PENDING_APPROVAL)]
    );

    expect(next).toBe(overrides);
    expect(applyOverrides([order('o1', OrderStatus.PENDING_APPROVAL)], next)[0].status)
      .toBe(OrderStatus.PRINTING);
  });

  /**
   * The case that made `from` necessary.
   *
   * Retiring only on an exact match with `to` meant an override survived the
   * server moving somewhere else entirely — the same shop acting on a second
   * device, an admin cancelling, a refund landing. The overlay went on
   * asserting a status the order had already left, visibly dragging it
   * backwards on screen, and nothing would ever clear it.
   */
  test('drops an override when the server has moved past it', () => {
    const next = retireConfirmedOverrides(
      { o1: pending(OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING) },
      [order('o1', OrderStatus.READY_FOR_PICKUP)]
    );

    expect(next).toEqual({});
    expect(applyOverrides([order('o1', OrderStatus.READY_FOR_PICKUP)], next)[0].status)
      .toBe(OrderStatus.READY_FOR_PICKUP);
  });

  test('drops an override when the server went somewhere unrelated', () => {
    // An admin cancelled it while the shop was marking it printing. The server
    // knows something we do not, and it wins.
    const next = retireConfirmedOverrides(
      { o1: pending(OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING) },
      [order('o1', OrderStatus.CANCELLED)]
    );

    expect(next).toEqual({});
  });

  test('keeps an override while the order is missing from the list entirely', () => {
    // A fetch that has not landed, or a filtered view. That is absence of
    // evidence, not evidence — dropping would flash the stale status when the
    // order reappeared.
    const overrides = { o1: pending(OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING) };
    expect(retireConfirmedOverrides(overrides, [])).toBe(overrides);
  });

  test('retires only the overrides with evidence against them', () => {
    const next = retireConfirmedOverrides(
      {
        o1: pending(OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING),
        o2: pending(OrderStatus.PRINTING, OrderStatus.READY_FOR_PICKUP),
      },
      [order('o1', OrderStatus.PRINTING), order('o2', OrderStatus.PRINTING)]
    );

    expect(Object.keys(next)).toEqual(['o2']);
  });

  test('returns the same object when nothing changed, so the effect cannot loop', () => {
    // This runs inside a setState in an effect keyed on the order list. A fresh
    // object every time would re-render, which would run the effect again.
    const overrides = { o1: pending(OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING) };

    expect(retireConfirmedOverrides(overrides, [order('o1', OrderStatus.PENDING_APPROVAL)]))
      .toBe(overrides);
    expect(retireConfirmedOverrides(overrides, [order('o1', OrderStatus.PRINTING)]))
      .not.toBe(overrides);
  });

  test('an empty overlay is returned untouched', () => {
    const empty = {};
    expect(retireConfirmedOverrides(empty, [order('o1', OrderStatus.PRINTING)])).toBe(empty);
  });
});

describe('the full lifecycle of one tap', () => {
  test('shows immediately, holds through a stale fetch, retires on confirmation', () => {
    const server = [order('o1', OrderStatus.PENDING_APPROVAL)];
    let overrides: StatusOverrides = {
      o1: pending(OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING),
    };

    // 1. The tap registers before any round trip.
    expect(applyOverrides(server, overrides)[0].status).toBe(OrderStatus.PRINTING);

    // 2. A superseded poll publishes nothing; the list is unchanged.
    overrides = retireConfirmedOverrides(overrides, server);
    expect(applyOverrides(server, overrides)[0].status).toBe(OrderStatus.PRINTING);

    // 3. The winning fetch arrives carrying the change.
    const confirmed = [order('o1', OrderStatus.PRINTING)];
    overrides = retireConfirmedOverrides(overrides, confirmed);

    expect(overrides).toEqual({});
    expect(applyOverrides(confirmed, overrides)[0].status).toBe(OrderStatus.PRINTING);
  });
});
