/**
 * `flagForReview` must match orders whose `paymentVerifiedVia` is still null.
 *
 * This is a guard against a regression that a mocked test *cannot* catch, and
 * that is the reason it is written as a source assertion rather than a
 * behavioural one. The bug was in SQL's treatment of NULL, not in JavaScript:
 *
 *     where: { paymentVerifiedVia: { not: 'amount_mismatch' } }
 *
 * compiles to `paymentVerifiedVia <> 'amount_mismatch'`, and in three-valued
 * logic `NULL <> 'x'` is NULL, not true. So the update matched **zero rows** for
 * every order that had never been through payment verification, `updateMany`
 * returned count 0, and the function returned early — no console line, no admin
 * alert. Silent.
 *
 * That is precisely inverted from its purpose. An order refused at the payment
 * boundary — wrong amount, or files changed after the price was set — is refused
 * *before* `paymentVerifiedVia` is ever written, so money was captured, the
 * order was not fulfilled, and nobody was told. It only ever appeared to work
 * because the orders it was tested against had already been fulfilled and
 * carried 'webhook' in that column.
 *
 * Found by driving the real webhook against a real Postgres and noticing the
 * alert that did not arrive. A Prisma mock returns whatever count it is told to,
 * so no amount of unit testing would have surfaced it — which is exactly why
 * this file guards the *shape* instead of pretending to prove the behaviour.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, '../services/payment.service.ts'), 'utf8');

/** The body of `flagForReview`, up to its closing `updateMany` call. */
function flagForReviewWhereClause(): string {
  const start = source.indexOf('async function flagForReview');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('data: { paymentVerifiedVia:', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('flagForReview null guard', () => {
  test('the where clause admits a null paymentVerifiedVia', () => {
    const where = flagForReviewWhereClause();

    expect(where).toContain('paymentVerifiedVia: null');
  });

  test('it still dedups against an order already flagged', () => {
    // The null arm must widen the match, not replace the dedup — otherwise
    // every reconciliation pass re-alerts on the same stuck order forever,
    // which trains admins to ignore the alert that matters.
    const where = flagForReviewWhereClause();

    expect(where).toContain("not: 'amount_mismatch'");
  });

  test('the two conditions are combined, not one or the other', () => {
    const where = flagForReviewWhereClause();

    expect(where).toContain('OR:');
    const nullArm = where.indexOf('paymentVerifiedVia: null');
    const notArm = where.indexOf("not: 'amount_mismatch'");
    const orAt = where.indexOf('OR:');
    expect(orAt).toBeLessThan(nullArm);
    expect(orAt).toBeLessThan(notArm);
  });
});
