import { describe, test, expect } from 'vitest';
import { createFetchGuard } from './fetchGuard';

/**
 * The rule every fetch in AppContext now follows: a response may only be
 * published if it is still the answer to the current question.
 *
 * These are written as the interleavings that actually happen, rather than as
 * assertions about sequence numbers, because the sequence number is an
 * implementation detail and the interleaving is the bug.
 */

/** A guard over a mutable session, so tests can sign in and out mid-flight. */
function guardWithSession(initial: string | null = 'user_a') {
  let session = initial;
  const guard = createFetchGuard(() => session);
  return {
    guard,
    signInAs: (id: string | null) => { session = id; },
  };
}

describe('a single fetch', () => {
  test('publishes when nothing has happened since', () => {
    const { guard } = guardWithSession();
    const isCurrent = guard('orders');
    expect(isCurrent()).toBe(true);
  });

  test('can be asked more than once', () => {
    const { guard } = guardWithSession();
    const isCurrent = guard('orders');
    expect(isCurrent()).toBe(true);
    expect(isCurrent()).toBe(true);
  });
});

describe('overlapping fetches of the same collection', () => {
  /**
   * The reversion bug. A poll starts, the shop owner marks an order ready, the
   * mutation's own refetch lands, and then the poll — carrying the pre-change
   * list — arrives last. Before the guard, it won.
   */
  test('a slow earlier fetch cannot overwrite a newer one', () => {
    const { guard } = guardWithSession();

    const poll = guard('orders');          // started first
    const afterMutation = guard('orders'); // started second

    expect(afterMutation()).toBe(true);
    expect(poll()).toBe(false);
  });

  test('holds however many are in flight', () => {
    const { guard } = guardWithSession();

    const first = guard('orders');
    const second = guard('orders');
    const third = guard('orders');

    expect(first()).toBe(false);
    expect(second()).toBe(false);
    expect(third()).toBe(true);
  });

  test('the newest stays valid after the older ones have resolved', () => {
    // Order of *resolution* must not matter — only order of starting.
    const { guard } = guardWithSession();

    const stale = guard('orders');
    const fresh = guard('orders');

    expect(stale()).toBe(false);
    expect(fresh()).toBe(true);
  });
});

describe('collections are independent', () => {
  test('fetching orders does not invalidate an in-flight notifications fetch', () => {
    const { guard } = guardWithSession();

    const notifications = guard('notifications');
    guard('orders');

    expect(notifications()).toBe(true);
  });

  test('each collection tracks its own sequence', () => {
    const { guard } = guardWithSession();

    const tickets = guard('tickets');
    guard('tickets');
    const payouts = guard('payouts');

    expect(tickets()).toBe(false);
    expect(payouts()).toBe(true);
  });
});

describe('the session changing underneath', () => {
  /**
   * The leak. A fetch begins while signed in; the user signs out; the response
   * arrives and writes their orders back into state the logout had just
   * cleared. On a shared campus device the next person sees them.
   */
  test('a fetch started while signed in cannot publish after signing out', () => {
    const { guard, signInAs } = guardWithSession('user_a');

    const inFlight = guard('orders');
    signInAs(null); // logout

    expect(inFlight()).toBe(false);
  });

  test('a fetch cannot publish into a different user’s session', () => {
    const { guard, signInAs } = guardWithSession('user_a');

    const inFlight = guard('orders');
    signInAs('user_b'); // someone else signs in on the same device

    expect(inFlight()).toBe(false);
  });

  test('signing back in as the same user does not resurrect a stale fetch', () => {
    // The sequence still has to hold: a newer fetch superseded this one.
    const { guard, signInAs } = guardWithSession('user_a');

    const inFlight = guard('orders');
    signInAs(null);
    signInAs('user_a');
    guard('orders');

    expect(inFlight()).toBe(false);
  });

  test('a fetch that starts and finishes signed out may still publish', () => {
    // Absence is not a change. The logged-out path clears collections, and that
    // work must not be blocked by the guard.
    const { guard } = guardWithSession(null);

    const inFlight = guard('shops');
    expect(inFlight()).toBe(true);
  });
});

describe('realistic interleavings', () => {
  test('logout during a burst leaves nothing publishable', () => {
    const { guard, signInAs } = guardWithSession('user_a');

    // The initial load fires every collection at once.
    const claims = ['shops', 'orders', 'notifications', 'payouts', 'tickets']
      .map((key) => guard(key));

    signInAs(null);

    expect(claims.every((isCurrent) => isCurrent() === false)).toBe(true);
  });

  test('a mutation refetch wins over the poll it raced', () => {
    const { guard } = guardWithSession('shop_owner');

    const poll = guard('orders');           // 15s poll fires
    const resume = guard('orders');         // app returns to foreground
    const afterUpdate = guard('orders');    // status change refetch

    // Only the last one started may write, whatever order they come back in.
    expect(resume()).toBe(false);
    expect(afterUpdate()).toBe(true);
    expect(poll()).toBe(false);
  });
});
