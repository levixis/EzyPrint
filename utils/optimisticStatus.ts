import { OrderStatus } from '../types';

/**
 * The optimistic order-status overlay.
 *
 * A shop owner is standing at the counter with a customer, so their tap has to
 * register before the round trip finishes. The overlay is drawn *over* the
 * server's orders rather than written into them, so a failure only drops the
 * overlay and the real state reappears — there is no reconciliation to get
 * wrong.
 *
 * Only order status is ever optimistic. Balances are not, and have no mutation
 * path at all: money that appears and then vanishes reads as money lost.
 *
 * Split out of the component because deciding when an override has served its
 * purpose is the part that is subtly wrong in every obvious formulation, and it
 * is far easier to state as a function of (overrides, orders) than to observe
 * in a rendered tree.
 */

export interface StatusCarrier {
  id: string;
  status: OrderStatus;
}

/**
 * A pending change, remembering what it was made against.
 *
 * `from` is the whole reason this is a record rather than a bare status. An
 * override retired on an exact match with `to` survives anything else — so if
 * the server moved somewhere *past* `to` (the same shop acting on a second
 * device, an admin cancelling, a refund landing), the overlay kept asserting a
 * status the order had already left and visibly dragged it backwards. Holding
 * `from` turns the question into one the data can answer: the server still
 * showing `from` means our change has not landed yet, and anything else means
 * the server knows something we do not.
 */
export interface PendingStatus {
  from: OrderStatus;
  to: OrderStatus;
}

export type StatusOverrides = Record<string, PendingStatus>;

/**
 * Apply pending overrides to the server's orders.
 *
 * An override matching the confirmed status is not applied — it has nothing to
 * say — which is what lets a matured override sit harmlessly between the fetch
 * that confirmed it and its retirement on the next render.
 */
export function applyOverrides<T extends StatusCarrier>(
  orders: T[],
  overrides: StatusOverrides
): T[] {
  return orders.map((order) => {
    const pending = overrides[order.id];
    return pending && pending.to !== order.status
      ? { ...order, status: pending.to }
      : order;
  });
}

/**
 * Drop overrides that have stopped being useful.
 *
 * An override survives exactly while the server still reports the status it was
 * made against. The moment the server reports anything else — our own change,
 * or something we did not know about — the server is the better source and the
 * overlay steps aside.
 *
 * An order missing from the list keeps its override: that is a fetch which has
 * not landed rather than evidence about the order, and dropping it would flash
 * the stale status the moment the order reappeared.
 *
 * Returns the *same object* when nothing changed, so a caller can use it in a
 * state updater without causing a further render.
 */
export function retireConfirmedOverrides(
  overrides: StatusOverrides,
  orders: StatusCarrier[]
): StatusOverrides {
  const pendingIds = Object.keys(overrides);
  if (pendingIds.length === 0) return overrides;

  const next = { ...overrides };
  let changed = false;

  for (const id of pendingIds) {
    const confirmed = orders.find((order) => order.id === id);
    if (confirmed && confirmed.status !== overrides[id].from) {
      delete next[id];
      changed = true;
    }
  }

  return changed ? next : overrides;
}
