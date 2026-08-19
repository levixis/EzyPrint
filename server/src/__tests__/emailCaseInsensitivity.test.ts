/**
 * An email address must identify the same account however it is capitalised.
 *
 * `User.email` is unique and was matched exactly everywhere. The schemas that
 * lowercase it have no effect, because `validate` parses a request to reject
 * bad input and never writes the parsed body back — so `.toLowerCase()` never
 * reaches a handler and the stored address is whatever the user typed. That
 * left two live faults:
 *
 *   - registering as `Name@gmail.com` and signing in as `name@gmail.com`
 *     failed as "invalid email or password", which is indistinguishable from a
 *     wrong password and so was unreportable by the person it happened to
 *   - the same person could hold two accounts differing only in case, and for
 *     a shop owner only one of them holds the money
 *
 * Matching case-insensitively fixes both without rewriting stored addresses.
 * These pin the lookup order too: exact first, so the common path stays on the
 * unique index and the result is deterministic if two case-variant rows already
 * exist.
 */

const mockFindUnique = jest.fn();
const mockFindFirst = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: { user: { findUnique: mockFindUnique, findFirst: mockFindFirst } },
}));

jest.mock('../config/env', () => {
  const actual = jest.requireActual('../config/env');
  return { ...actual, env: { ...actual.env, GOOGLE_CLIENT_IDS: ['x'] } };
});

import { findUserIdByEmail } from '../services/auth.service';

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUnique.mockResolvedValue(null);
  mockFindFirst.mockResolvedValue(null);
});

describe('resolving an account from an email address', () => {
  test('an exact match is used without a second query', async () => {
    mockFindUnique.mockResolvedValue({ id: 'user_1' });

    expect(await findUserIdByEmail('name@gmail.com')).toBe('user_1');

    // The unique index answers the common case; falling straight to a
    // case-insensitive scan would put every login on a sequential scan.
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  test('a case variant is found when the exact form is not stored', async () => {
    mockFindUnique.mockResolvedValue(null);
    mockFindFirst.mockResolvedValue({ id: 'user_1' });

    expect(await findUserIdByEmail('name@gmail.com')).toBe('user_1');
  });

  test('the fallback asks the database to ignore case', async () => {
    // Postgres comparison is case-sensitive by default, so the mode is the
    // whole fix — without it the second query is the first one again.
    mockFindUnique.mockResolvedValue(null);
    mockFindFirst.mockResolvedValue({ id: 'user_1' });

    await findUserIdByEmail('Name@Gmail.com');

    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: 'Name@Gmail.com', mode: 'insensitive' } },
      })
    );
  });

  test('an address with no account resolves to null', async () => {
    expect(await findUserIdByEmail('nobody@gmail.com')).toBeNull();
  });

  test('the exact match wins over a case variant', async () => {
    // Two rows differing only in case can already exist, because the old
    // behaviour allowed both to be registered. The address as typed is the one
    // that should answer, rather than whichever row the database returns first.
    mockFindUnique.mockResolvedValue({ id: 'exact' });
    mockFindFirst.mockResolvedValue({ id: 'variant' });

    expect(await findUserIdByEmail('name@gmail.com')).toBe('exact');
  });
});
