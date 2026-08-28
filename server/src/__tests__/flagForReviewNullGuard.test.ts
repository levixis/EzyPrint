/**
 * `flagForReview` must match orders that have never been flagged before.
 *
 * This is a guard against a regression that a mocked test *cannot* catch, and
 * that is the reason it is written as a source assertion rather than a
 * behavioural one. The bug was in SQL's treatment of NULL, not in JavaScript:
 *
 *     where: { needsReviewReason: { not: reason } }
 *
 * compiles to `"needsReviewReason" <> $1`, and in three-valued logic
 * `NULL <> 'x'` is NULL, not true. So the update matches **zero rows** for every
 * order that has never been flagged, `updateMany` returns count 0, and the
 * function returns early — no console line, no admin alert. Silent.
 *
 * That is precisely inverted from its purpose. An order refused at the payment
 * boundary — wrong amount, or files changed after the price was set — is refused
 * before it has ever been flagged, so money was captured, the order was not
 * fulfilled, and nobody was told. It only ever appeared to work because the
 * orders it was tested against had already been through the path that wrote the
 * column.
 *
 * Found by driving the real webhook against a real Postgres and noticing the
 * alert that did not arrive. A Prisma mock returns whatever count it is told to,
 * so no amount of unit testing would have surfaced it — which is exactly why
 * this file guards the *shape* instead of pretending to prove the behaviour.
 *
 * The dedup column changed once, and the reason is worth keeping here. It was
 * `paymentVerifiedVia`, which records which of the three paths confirmed a
 * payment — 'signature', 'webhook', 'recovery'. Using it as a flag sentinel
 * overwrote that answer for exactly the orders somebody was about to
 * investigate, so the flag was given its own columns and this guard moved with
 * it. The last test below is what stops it moving back.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, '../services/payment.service.ts'), 'utf8');

/**
 * The body of `flagForReview`, split at its `data:` clause — code only.
 *
 * Comments are stripped because this file asserts what the query *does*, and the
 * function's comments necessarily name the column it deliberately no longer
 * touches. Asserting over prose would make the explanation fail the test that
 * the explanation exists to justify.
 */
function flagForReview(): { where: string; data: string } {
  const start = source.indexOf('async function flagForReview');
  expect(start).toBeGreaterThan(-1);

  const dataAt = source.indexOf('data: { needsReviewReason', start);
  expect(dataAt).toBeGreaterThan(start);

  const end = source.indexOf('if (marked.count === 0)', dataAt);
  expect(end).toBeGreaterThan(dataAt);

  const codeOnly = (text: string) =>
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

  return {
    where: codeOnly(source.slice(start, dataAt)),
    data: codeOnly(source.slice(dataAt, end)),
  };
}

describe('flagForReview null guard', () => {
  test('the where clause admits an order that has never been flagged', () => {
    expect(flagForReview().where).toContain('needsReviewReason: null');
  });

  test('it still dedups against an order already flagged for the same reason', () => {
    // The null arm must widen the match, not replace the dedup — otherwise
    // every reconciliation pass re-alerts on the same stuck order forever,
    // which trains admins to ignore the alert that matters.
    expect(flagForReview().where).toContain('not: reason');
  });

  test('the two conditions are combined, not one or the other', () => {
    const { where } = flagForReview();

    expect(where).toContain('OR:');
    const nullArm = where.indexOf('needsReviewReason: null');
    const notArm = where.indexOf('not: reason');
    const orAt = where.indexOf('OR:');
    expect(orAt).toBeLessThan(nullArm);
    expect(orAt).toBeLessThan(notArm);
  });

  test('flagging never writes paymentVerifiedVia', () => {
    // That column is provenance — which path confirmed the payment. Flagging an
    // order for review must not destroy the answer for the one order somebody
    // is about to look at.
    const { where, data } = flagForReview();

    expect(data).not.toContain('paymentVerifiedVia');
    expect(where).not.toContain('paymentVerifiedVia');
  });
});
