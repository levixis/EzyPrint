/**
 * The shop refund velocity cap must count refunds that are already in flight.
 *
 * `shopRefundOrder` serialises the check properly — `pg_advisory_xact_lock` on
 * the shop, then a count of today's refunds. But it counted `adminResolvedAt`,
 * and the transaction holding the lock did not write it: `settleClaimedRefund`
 * did, in a *different* transaction, after a Razorpay round trip.
 *
 * So the lock was serialising a read of a value written outside it. Every
 * request that started while an earlier one was still at the gateway counted
 * zero prior refunds. Ten fired together all passed a cap none could see the
 * others against — ₹5,000 in one burst against a ₹2,000 daily ceiling, and ten
 * against a ten-per-day count, repeatable every fifteen minutes.
 *
 * `shopRefundEscalationReason` (the policy) is tested in shopRefund.test.ts.
 * This file tests the accounting the policy is fed.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, '../services/refund.service.ts'), 'utf8');

/** `shopRefundOrder`'s transaction body, comments stripped. */
function claimTransaction(): string {
  const start = source.indexOf('export async function shopRefundOrder');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('if (escalationReason) {', start);
  expect(end).toBeGreaterThan(start);

  return source
    .slice(start, end)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
}

describe('the counted column is written by the transaction that holds the lock', () => {
  const tx = claimTransaction();

  test('the count still reads adminResolvedAt', () => {
    // Unchanged — the fix is to write it here, not to count something else.
    expect(tx).toContain('adminResolvedAt: { gte: since }');
  });

  test('and the claim now writes it', () => {
    expect(tx).toContain('adminResolvedAt: new Date()');
  });

  test('on both branches — taking over a student’s claim, and creating a new row', () => {
    // `orderId` is unique on RefundRequest, so a shop refunding an order the
    // student already raised a claim for updates that row instead of inserting.
    // Both paths have to be visible to the counter or the gap just moves.
    const spreads = tx.match(/\.\.\.attemptStartedAt/g) ?? [];
    expect(spreads).toHaveLength(2);
  });

  test('the lock is still taken before the count', () => {
    const lockAt = tx.indexOf('pg_advisory_xact_lock');
    const countAt = tx.indexOf('adminResolvedAt: { gte: since }');

    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(countAt);
  });

  test('and the stamp lands inside the same transaction, before it commits', () => {
    const lockAt = tx.indexOf('pg_advisory_xact_lock');
    const stampAt = tx.indexOf('adminResolvedAt: new Date()');

    expect(stampAt).toBeGreaterThan(lockAt);
  });
});

describe('an escalated claim is not counted as a refund', () => {
  const tx = claimTransaction();

  test('the stamp is conditional on the refund actually going ahead', () => {
    // APPROVED_BY_SHOP is a request for an admin to decide; nothing has been
    // resolved, and it is excluded from the counted statuses for that reason.
    expect(tx).toContain('const attemptStartedAt = escalationReason ? {} : { adminResolvedAt: new Date() }');
  });

  test('the counted statuses are the ones where money is moving or has moved', () => {
    // Scoped to the count's own where clause: APPROVED_BY_SHOP appears elsewhere
    // in the function as the status an escalation writes, which is the point.
    const countWhere = tx.slice(tx.indexOf('settledToday'), tx.indexOf('const countToday'));

    expect(countWhere).toContain("status: { in: ['PROCESSING_REFUND', 'RESOLVED_REFUNDED', 'REFUND_SETTLED_OFFLINE'] }");
    expect(countWhere).not.toContain('APPROVED_BY_SHOP');
  });
});

describe('the gateway call stays outside the lock', () => {
  test('settleClaimedRefund is called after the transaction, not inside it', () => {
    // The fix must not have "solved" the race by pulling a network round trip
    // into a transaction holding a shop-wide advisory lock — that trades a cap
    // bypass for a pool deadlock.
    const start = source.indexOf('export async function shopRefundOrder');
    const lockAt = source.indexOf('pg_advisory_xact_lock', start);
    const escalationAt = source.indexOf('if (escalationReason) {', start);
    const settleAt = source.indexOf('await settleClaimedRefund(', start);

    expect(lockAt).toBeGreaterThan(start);
    expect(settleAt).toBeGreaterThan(escalationAt);
  });
});
