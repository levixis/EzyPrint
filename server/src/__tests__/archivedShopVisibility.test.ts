/**
 * Who can still see a shop once it has been archived.
 *
 * Archiving is supposed to be appealable: the owner signs in, sees "Shop
 * Archived", and taps "Request Reactivation". It was not appealable, because
 * of this list.
 *
 * `GET /shops` answered every non-admin caller with `listShopsForStudents`,
 * which filters `isArchived: false`. The client picks the owner's screen by
 * looking their own shop up in that list — dashboard if present, reactivation
 * banner if present and archived — so an archived shop, absent from the list
 * entirely, produced neither. The owner sat on "Loading your shop dashboard…"
 * forever and the reactivation screen was unreachable. A one-way door.
 *
 * These tests run the real `where` clause against fixture rows rather than
 * asserting on its shape, because the bug was never in the shape: `isArchived:
 * false` is exactly right for students and exactly wrong for the owner. Only
 * evaluating it against an archived shop tells the two apart.
 */

const mockFindMany = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: { shop: { findMany: mockFindMany } },
}));

import { listShopsForStudents } from '../services/shop.service';

const OWNER = 'user_owner';
const OTHER_OWNER = 'user_other';

type Row = {
  id: string;
  name: string;
  ownerUserId: string;
  isApproved: boolean;
  isArchived: boolean;
  isOpen: boolean;
};

const ROWS: Row[] = [
  { id: 'archived',   name: 'Archived Shop',   ownerUserId: OWNER,       isApproved: true,  isArchived: true,  isOpen: false },
  { id: 'unapproved', name: 'Unapproved Shop', ownerUserId: OWNER,       isApproved: false, isArchived: false, isOpen: false },
  { id: 'closed',     name: 'Closed Shop',     ownerUserId: OWNER,       isApproved: true,  isArchived: false, isOpen: false },
  { id: 'live',       name: 'Live Shop',       ownerUserId: OTHER_OWNER, isApproved: true,  isArchived: false, isOpen: true  },
  { id: 'shut',       name: 'Shut Shop',       ownerUserId: OTHER_OWNER, isApproved: true,  isArchived: false, isOpen: false },
  // Somebody else's archived shop. Exists so "the owner sees archived shops"
  // cannot pass by accidentally showing everyone every archived shop.
  { id: 'foreign-archived', name: 'Not Yours', ownerUserId: OTHER_OWNER, isApproved: true, isArchived: true, isOpen: false },
];

/** The subset of Prisma's `where` semantics this service actually uses. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  if (Array.isArray(where.OR)) {
    return (where.OR as Record<string, unknown>[]).some(branch => matches(row, branch));
  }
  return Object.entries(where).every(([field, expected]) => row[field as keyof Row] === expected);
}

beforeEach(() => {
  mockFindMany.mockReset();
  mockFindMany.mockImplementation((args: { where: Record<string, unknown> }) =>
    Promise.resolve(ROWS.filter(row => matches(row, args.where)))
  );
});

const idsFrom = (rows: { id: string }[]) => rows.map(r => r.id).sort();

describe('a shop owner always gets their own shop back', () => {
  it('returns it when it is archived — this is the bug', async () => {
    const shops = await listShopsForStudents({ includeOwnedBy: OWNER });
    expect(idsFrom(shops)).toContain('archived');
  });

  it('returns it when it is not yet approved', async () => {
    const shops = await listShopsForStudents({ includeOwnedBy: OWNER });
    expect(idsFrom(shops)).toContain('unapproved');
  });

  it('returns it when closed, even under onlyOpen', async () => {
    // The owner's own branch carries no isOpen filter. A shop owner closing up
    // for the night must not lose their own dashboard.
    const shops = await listShopsForStudents({ onlyOpen: true, includeOwnedBy: OWNER });
    expect(idsFrom(shops)).toContain('closed');
  });

  it('does not drag in other people’s archived shops', async () => {
    const shops = await listShopsForStudents({ includeOwnedBy: OWNER });
    // Exactly: the owner's three, whatever state they are in, plus the two
    // shops any student would see. Nobody else's archived shop.
    expect(idsFrom(shops)).toEqual(['archived', 'closed', 'live', 'shut', 'unapproved']);
  });
});

describe('everyone else sees the student list, unchanged', () => {
  it('hides archived and unapproved shops when no owner is named', async () => {
    const shops = await listShopsForStudents();
    expect(idsFrom(shops)).toEqual(['closed', 'live', 'shut']);
  });

  it('still honours onlyOpen', async () => {
    const shops = await listShopsForStudents({ onlyOpen: true });
    expect(idsFrom(shops)).toEqual(['live']);
  });

  it('does not leak one owner’s archived shop to another owner', async () => {
    const shops = await listShopsForStudents({ includeOwnedBy: OTHER_OWNER });
    expect(idsFrom(shops)).toContain('foreign-archived'); // their own, correctly
    expect(idsFrom(shops)).not.toContain('archived');
    expect(idsFrom(shops)).not.toContain('unapproved');
  });
});

describe('the projection stays public', () => {
  it('never selects balances, payout methods or the owner id', async () => {
    await listShopsForStudents({ includeOwnedBy: OWNER });
    const select = mockFindMany.mock.calls[0][0].select as Record<string, unknown>;
    // Widening *who* sees a row must not widen *what* the row contains — the
    // owner has guarded endpoints for their balances and bank details.
    for (const secret of ['payoutMethods', 'pendingBalance', 'ledgerBalance', 'debtAmount', 'ownerUserId', 'rejectionReason']) {
      expect(select[secret]).toBeUndefined();
    }
    expect(select.isArchived).toBe(true); // the client needs this to pick the screen
  });
});
