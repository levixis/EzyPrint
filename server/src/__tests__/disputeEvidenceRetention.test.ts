/**
 * A party to a dispute must not be able to destroy the other party's evidence.
 *
 * `ticket.service`'s permission table states the rule outright — a shop may mark
 * a ticket RESOLVED but may not CLOSE it, because *"a party to a dispute should
 * not be able to file it away"*, and the raiser may reopen it. Eighty lines
 * later, `updateTicketStatus` purged every attachment on any RESOLVED, hard,
 * immediately, rows and objects both.
 *
 * Two artefacts went, not one. Beyond the photographs, an open ticket on
 * `relatedOrderId` is what pins the *printed document* — so resolving also
 * released the order's files to the next retention sweep. In a "you printed the
 * wrong thing" dispute that file is the entire factual question.
 *
 * These tests pin the two halves of the fix: which states purge, and how long a
 * RESOLVED ticket keeps its evidence.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { RESOLVED_TICKET_GRACE_DAYS, resolvedTicketCutoff } from '../services/cleanup.service';

const ticketSource = readFileSync(join(__dirname, '../services/ticket.service.ts'), 'utf8');
const cleanupSource = readFileSync(join(__dirname, '../services/cleanup.service.ts'), 'utf8');

/** Code only — the comments necessarily describe the behaviour being removed. */
const codeOnly = (text: string) =>
  text.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');

describe('the inline purge fires only on a neutral party’s decision', () => {
  const trigger = codeOnly(
    ticketSource.slice(
      ticketSource.indexOf('const resolvedByNeutralParty'),
      ticketSource.indexOf('return updatedTicket;')
    )
  );

  test('CLOSED always purges — only the raiser or an admin can set it', () => {
    expect(trigger).toContain("newStatus === 'CLOSED'");
  });

  test('RESOLVED purges only when an admin set it', () => {
    expect(trigger).toContain("newStatus === 'RESOLVED'");
    expect(trigger).toContain("changedByUserType === 'ADMIN'");
  });

  test('a bare RESOLVED no longer triggers anything', () => {
    // The regression in its exact form: `newStatus === 'RESOLVED' || newStatus === 'CLOSED'`
    // is what let a shop delete a complaint's evidence with one button.
    expect(trigger).not.toContain("newStatus === 'RESOLVED' || newStatus === 'CLOSED'");
  });
});

describe('a shop may still resolve — it just no longer destroys anything', () => {
  const transitions = ticketSource.slice(
    ticketSource.indexOf('const TICKET_TRANSITIONS'),
    ticketSource.indexOf('export async function updateTicketStatus')
  );

  test('the shop keeps RESOLVED, because answering a complaint is its job', () => {
    expect(transitions).toContain("SHOP_OWNER: ['IN_REVIEW', 'RESOLVED']");
  });

  test('and still may not CLOSE', () => {
    // Unchanged, and the reason the purge could not key on RESOLVED: the file's
    // own rule is that RESOLVED is a claim, not a settlement.
    expect(transitions).not.toContain("SHOP_OWNER: ['IN_REVIEW', 'RESOLVED', 'CLOSED']");
  });

  test('the raiser can reopen, which is what the grace period exists to allow', () => {
    expect(transitions).toContain("RAISER: ['IN_REVIEW', 'CLOSED']");
  });
});

describe('the grace period', () => {
  test('is long enough for a student to disagree', () => {
    expect(RESOLVED_TICKET_GRACE_DAYS).toBeGreaterThanOrEqual(3);
  });

  test('is short enough that a settled ticket is not held for a month', () => {
    expect(RESOLVED_TICKET_GRACE_DAYS).toBeLessThanOrEqual(30);
  });

  test('the cutoff is exactly that many days back', () => {
    const now = new Date('2026-08-26T12:00:00.000Z');
    const cutoff = resolvedTicketCutoff(now);

    expect(now.getTime() - cutoff.getTime()).toBe(RESOLVED_TICKET_GRACE_DAYS * 24 * 60 * 60 * 1000);
  });

  test('a ticket resolved a moment ago is inside it', () => {
    const now = new Date('2026-08-26T12:00:00.000Z');
    const justNow = new Date(now.getTime() - 60_000);

    expect(justNow.getTime()).toBeGreaterThan(resolvedTicketCutoff(now).getTime());
  });

  test('a ticket resolved a day past it is outside', () => {
    const now = new Date('2026-08-26T12:00:00.000Z');
    const old = new Date(now.getTime() - (RESOLVED_TICKET_GRACE_DAYS + 1) * 24 * 60 * 60 * 1000);

    expect(old.getTime()).toBeLessThan(resolvedTicketCutoff(now).getTime());
  });
});

describe('an order’s documents stay pinned while a complaint is contestable', () => {
  const dispute = codeOnly(
    cleanupSource.slice(
      cleanupSource.indexOf('async function hasOpenDispute'),
      cleanupSource.indexOf('export async function purgeOrderFiles')
    )
  );

  test('OPEN and IN_REVIEW pin the files, as before', () => {
    expect(dispute).toContain("status: { in: ['OPEN', 'IN_REVIEW'] }");
  });

  test('and so does a RESOLVED ticket inside its grace period', () => {
    // Without this, a shop marking a complaint against itself RESOLVED released
    // the printed document to the very next retention sweep.
    expect(dispute).toContain("status: 'RESOLVED'");
    expect(dispute).toContain('resolvedTicketCutoff');
  });
});

describe('the retention sweep collects on the same rule', () => {
  const sweep = codeOnly(
    cleanupSource.slice(cleanupSource.indexOf('export async function sweepUndeletedFiles'))
  );

  test('CLOSED tickets are collected without waiting', () => {
    expect(sweep).toContain("{ status: 'CLOSED' }");
  });

  test('RESOLVED ones wait out the grace period', () => {
    expect(sweep).toContain("status: 'RESOLVED', updatedAt: { lt: resolvedTicketCutoff(now) }");
  });

  test('the old unconditional RESOLVED selection is gone', () => {
    expect(sweep).not.toContain("status: { in: ['RESOLVED', 'CLOSED'] }");
  });

  test('the disputed-order exclusion is bounded by the candidate batch, not by the backlog', () => {
    // It read every contested ticket in the system into memory and sent the whole
    // list back as a `notIn`, which grows with unresolved disputes and eventually
    // exceeds Postgres' 65,535 bound-parameter ceiling — and file-retention
    // failing is what leaves student documents in the bucket.
    expect(sweep).toContain('relatedOrderId: { in: candidates.map');
    expect(sweep).not.toContain('id: { notIn: disputedOrderIds }');
  });
});
