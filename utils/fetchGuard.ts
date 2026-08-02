/**
 * Deciding whether a response that has just arrived is still wanted.
 *
 * Every collection in `AppContext` is fetched from several places at once — the
 * initial load, two polling intervals, the Android foreground handler, and the
 * explicit refresh after a mutation. None of them checked, on arrival, whether
 * the answer still matched the question. Whichever response *resolved* last
 * won, regardless of which request *started* last.
 *
 * Two failures followed from that.
 *
 * A poll that started before a status change could land after it and put the
 * old status back — after the optimistic overlay had already been dropped, so
 * nothing masked the reversion and the shop owner watched their own tap undo
 * itself.
 *
 * And a fetch begun while signed in could resolve after signing out, writing
 * one person's orders back into state the logout had just cleared, where the
 * next person to use the device would see them.
 *
 * Kept out of the component so it can be tested directly: this is concurrency
 * logic, and concurrency logic asserted through a rendered tree tends to be
 * tested only in the ordering that happens to occur.
 */

export type FetchClaim = () => boolean;

export interface FetchGuard {
  /**
   * Claim the right to publish a fetch's result.
   *
   * Call before awaiting; call the returned predicate before writing state. It
   * answers false when a newer fetch of the same key has begun since, or when
   * the session changed underneath — including to nobody.
   */
  (key: string): FetchClaim;
}

/**
 * Build a guard bound to a session identity.
 *
 * `getSessionId` is read twice — once when a fetch starts and again when it
 * resolves — so that a response cannot be published into a session other than
 * the one that asked for it. Returning null means signed out, and null compares
 * equal to null, so a fetch that starts and finishes while signed out is still
 * allowed to publish; it is a *change* that invalidates, not absence.
 */
export function createFetchGuard(getSessionId: () => string | null): FetchGuard {
  const sequences: Record<string, number> = {};

  return function claim(key: string): FetchClaim {
    const seq = (sequences[key] ?? 0) + 1;
    sequences[key] = seq;
    const sessionAtStart = getSessionId();

    return () => sequences[key] === seq && getSessionId() === sessionAtStart;
  };
}
