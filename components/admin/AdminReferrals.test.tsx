import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReferralCode } from '../../lib/queries';

/**
 * The referral list only ever grew: every code ever issued stayed in one
 * undifferentiated table, and a used one carried no indication of who it had
 * let in. Retention is deliberate — a spent code is the record of which admin
 * authorised which shop owner — so the fix is what the admin is shown, not what
 * is stored.
 */

const listMock = vi.fn();

vi.mock('../../lib/queries', () => ({
  referralApi: {
    list: () => listMock(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}));

let AdminReferrals: React.ComponentType;
let referralStatus: (code: ReferralCode, now?: Date) => string;

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import('./AdminReferrals');
  AdminReferrals = mod.default;
  referralStatus = mod.referralStatus;
});

const day = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const active: ReferralCode = {
  id: 'c1',
  code: 'EZY-ACTIVE',
  createdAt: iso(-day),
  expiresAt: iso(6 * day),
  creator: { name: 'Levixis', email: 'admin@ezyprint.in' },
};

const used: ReferralCode = {
  id: 'c2',
  code: 'EZY-USED',
  createdAt: iso(-10 * day),
  expiresAt: iso(-3 * day),
  usedBy: 'usr_9',
  usedAt: iso(-9 * day),
  creator: { name: 'Levixis', email: 'admin@ezyprint.in' },
  user: { name: 'Aman', email: 'aman@x.com', shop: { name: 'Campus Copies' } },
};

const expired: ReferralCode = {
  id: 'c3',
  code: 'EZY-EXPIRED',
  createdAt: iso(-30 * day),
  expiresAt: iso(-20 * day),
  creator: { name: 'Levixis', email: 'admin@ezyprint.in' },
};

const renderList = async (codes: ReferralCode[]) => {
  listMock.mockResolvedValue(codes);
  render(<AdminReferrals />);
  await screen.findByRole('tablist');
};

describe('referralStatus', () => {
  test('a code with usedAt is used even once its expiry has passed', () => {
    // Otherwise a spent code would reappear as "Expired" and look reusable.
    expect(referralStatus(used)).toBe('used');
  });

  test('a spent code whose owner was deleted is still used', () => {
    // usedBy is a foreign key that clears on account deletion; usedAt does not.
    const orphaned = { ...used, usedBy: null, user: null };
    expect(referralStatus(orphaned)).toBe('used');
  });

  test('an unused code past its expiry is expired', () => {
    expect(referralStatus(expired)).toBe('expired');
  });

  test('a code with no expiry never expires', () => {
    expect(referralStatus({ ...active, expiresAt: null })).toBe('active');
  });
});

describe('Filtering the list', () => {
  test('opens on Active, so used codes are not in the way', async () => {
    await renderList([active, used, expired]);

    expect(screen.getByText('EZY-ACTIVE')).toBeDefined();
    expect(screen.queryByText('EZY-USED')).toBeNull();
    expect(screen.queryByText('EZY-EXPIRED')).toBeNull();
  });

  test('each filter shows its own codes', async () => {
    await renderList([active, used, expired]);

    await userEvent.click(screen.getByRole('tab', { name: /Used/ }));
    expect(screen.getByText('EZY-USED')).toBeDefined();
    expect(screen.queryByText('EZY-ACTIVE')).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: /Expired/ }));
    expect(screen.getByText('EZY-EXPIRED')).toBeDefined();
    expect(screen.queryByText('EZY-USED')).toBeNull();
  });

  test('All still shows everything', async () => {
    await renderList([active, used, expired]);
    await userEvent.click(screen.getByRole('tab', { name: /All/ }));

    expect(screen.getByText('EZY-ACTIVE')).toBeDefined();
    expect(screen.getByText('EZY-USED')).toBeDefined();
    expect(screen.getByText('EZY-EXPIRED')).toBeDefined();
  });

  test('the tabs count what they contain', async () => {
    await renderList([active, used, expired, { ...expired, id: 'c4', code: 'EZY-OLD' }]);

    expect(screen.getByRole('tab', { name: /Expired/ }).textContent).toContain('2');
    expect(screen.getByRole('tab', { name: /^All/ }).textContent).toContain('4');
  });

  test('an empty filter says so rather than looking broken', async () => {
    await renderList([used]);
    // Opens on Active, which has nothing in it.
    expect(screen.getByText(/No active codes/)).toBeDefined();
  });
});

describe('Who a code let in', () => {
  test('a used code names the shop and the owner', async () => {
    await renderList([used]);
    await userEvent.click(screen.getByRole('tab', { name: /Used/ }));

    expect(screen.getByText(/Campus Copies/)).toBeDefined();
    expect(screen.getByText(/Aman/)).toBeDefined();
  });

  test('a deleted owner is labelled, not left blank', async () => {
    // The row survives the account on purpose — showing nothing would read as
    // an unused code.
    await renderList([{ ...used, usedBy: null, user: null }]);
    await userEvent.click(screen.getByRole('tab', { name: /Used/ }));

    expect(screen.getAllByText('Deleted account').length).toBeGreaterThan(0);
  });

  test('an unused code has nobody to name', async () => {
    await renderList([active]);
    expect(screen.getByText('—')).toBeDefined();
  });

  test('a used code offers no Delete button', async () => {
    await renderList([used]);
    await userEvent.click(screen.getByRole('tab', { name: /Used/ }));
    expect(screen.queryByText('Delete')).toBeNull();
  });

  test('an expired code can still be deleted by hand', async () => {
    await renderList([expired]);
    await userEvent.click(screen.getByRole('tab', { name: /Expired/ }));
    expect(screen.getByText('Delete')).toBeDefined();
  });
});
