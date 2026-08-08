/**
 * The alerting must not become something you mute.
 *
 * This file exists because it did. A stuck background job produced roughly
 * twelve CRITICAL emails in ninety minutes, and every one said the same thing.
 * Four separate defects combined to defeat every guard that was supposed to
 * prevent exactly that:
 *
 *  1. The noise-stripping regex was `\b\d+\b`, which does not match the digits
 *     in "39m" — there is no word boundary between `9` and `m`. Health
 *     summaries embed live durations, so every cycle produced a different
 *     message, a different fingerprint, and therefore a brand-new event. New
 *     events skip the cooldown by design, so the cooldown never once applied.
 *
 *  2. Identity was derived from the message at all. Health summaries are
 *     written to be read by a human and deliberately contain changing numbers,
 *     which is the worst possible input to a normalization heuristic.
 *
 *  3. Every database-backed check failed together when Neon closed an idle
 *     connection, and each escalated on its own — one outage, four emails.
 *
 *  4. A single failed cycle paged immediately, so routine connection
 *     housekeeping woke someone up.
 *
 * Each is pinned below. The through-line: an alert channel's failure mode is
 * volume, not silence.
 */

const mockSystemEventFindUnique = jest.fn();
const mockSystemEventUpsert = jest.fn();
const mockSystemEventUpdateMany = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    systemEvent: {
      findUnique: mockSystemEventFindUnique,
      upsert: mockSystemEventUpsert,
      updateMany: mockSystemEventUpdateMany,
    },
    remediationLog: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    notification: { createMany: jest.fn() },
  },
}));

const mockRunHealthChecks = jest.fn();
jest.mock('../services/health.service', () => ({ runHealthChecks: mockRunHealthChecks }));

jest.mock('../services/realtime.service', () => ({ dispatchOutbox: jest.fn() }));
jest.mock('../services/payment.service', () => ({ reconcilePayments: jest.fn() }));
jest.mock('../services/settlement.service', () => ({ runSettlementSweep: jest.fn() }));
jest.mock('../services/email.service', () => ({ sendNoticeEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/push.service', () => ({ sendPushToUser: jest.fn().mockResolvedValue(undefined) }));

import { __testing as obs, captureError } from '../services/observability.service';
import { runWatchdogCycle, __testing as wd } from '../services/watchdog.service';
import * as alert from '../services/alert.service';
import { env } from '../config/env';

const { normalize, fingerprint } = obs;

// ─────────────────────────────────────────────────────────────
describe('Defect 1 — durations defeated the fingerprint', () => {
  test('digits glued to a unit are stripped', () => {
    expect(normalize('last success 39m ago')).toBe(normalize('last success 5m ago'));
    expect(normalize('took 200ms')).toBe(normalize('took 17ms'));
    expect(normalize('retry in 30s')).toBe(normalize('retry in 5s'));
  });

  test('the scheduler summary that caused the flood now collapses', () => {
    const a = 'Background jobs have stopped running: settlement (last success 39m ago), outbox (last success 5m ago)';
    const b = 'Background jobs have stopped running: settlement (last success 16m ago), outbox (last success 17m ago)';
    expect(fingerprint('health', a)).toBe(fingerprint('health', b));
  });

  test('genuinely different faults still stay apart', () => {
    expect(fingerprint('health', 'outbox stalled')).not.toBe(
      fingerprint('health', 'settlement stalled')
    );
  });
});

// ─────────────────────────────────────────────────────────────
describe('Defect 2 — identity comes from the check, not its wording', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSystemEventFindUnique.mockResolvedValue(null);
    mockSystemEventUpsert.mockImplementation(async ({ where }) => ({
      id: 'evt', fingerprint: where.fingerprint, severity: 'CRITICAL', source: 'health',
      message: 'x', count: 1, lastAlertedAt: null, firstSeenAt: new Date(),
    }));
  });

  test('two differently-worded reports of one check share a fingerprint', async () => {
    const first = await captureError({
      source: 'health', message: '[scheduler] stalled 39m', fingerprintKey: 'health:scheduler',
    });
    const second = await captureError({
      source: 'health', message: '[scheduler] stalled 4h, 2 jobs, 17 entries', fingerprintKey: 'health:scheduler',
    });

    expect(first?.fingerprint).toBe(second?.fingerprint);
  });

  test('different checks still get different fingerprints', async () => {
    const a = await captureError({ source: 'health', message: 'x', fingerprintKey: 'health:scheduler' });
    const b = await captureError({ source: 'health', message: 'x', fingerprintKey: 'health:database' });

    expect(a?.fingerprint).not.toBe(b?.fingerprint);
  });
});

// ─────────────────────────────────────────────────────────────
describe('Defect 3 — one outage, one alert', () => {
  const dbDownReport = () => ({
    status: 'down' as const,
    checkedAt: new Date().toISOString(),
    uptimeSeconds: 100,
    environment: 'test',
    checks: [
      { name: 'database', status: 'fail' as const, summary: 'Server has closed the connection' },
      { name: 'errors', status: 'fail' as const, summary: 'Invalid prisma.systemEvent.count()' },
      { name: 'webhooks', status: 'fail' as const, summary: 'Invalid prisma.webhookEvent.count()' },
      { name: 'scheduler', status: 'fail' as const, summary: 'Invalid prisma.jobHeartbeat.findMany()' },
      { name: 'settlement_backlog', status: 'fail' as const, summary: 'Invalid prisma.ledgerEntry.count()' },
    ],
  });

  let sent: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    wd.resetStreaks();
    sent = [];
    jest.spyOn(alert, 'maybeSend').mockImplementation(async (_event, message) => {
      sent.push(message.title);
      return true;
    });
    mockSystemEventFindUnique.mockResolvedValue(null);
    mockSystemEventUpsert.mockImplementation(async ({ where }) => ({
      id: 'evt', fingerprint: where.fingerprint, severity: 'CRITICAL', source: 'health',
      message: 'x', count: 1, lastAlertedAt: null, firstSeenAt: new Date(),
    }));
    mockRunHealthChecks.mockResolvedValue(dbDownReport());
  });

  afterEach(() => jest.restoreAllMocks());

  test('a database outage alerts about the database only', async () => {
    // Two cycles, because escalation now waits for confirmation.
    await runWatchdogCycle();
    await runWatchdogCycle();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('database');
  });

  test('the dependent checks still show as failing on the dashboard', async () => {
    const { report } = await runWatchdogCycle();

    // Suppressed from the alert, not from the diagnosis — an operator opening
    // the panel must still see everything that is broken.
    expect(report.checks.filter((c) => c.status === 'fail')).toHaveLength(5);
  });
});

// ─────────────────────────────────────────────────────────────
describe('Defect 4 — a single blip does not page anyone', () => {
  const report = (status: 'ok' | 'fail') => ({
    status: status === 'ok' ? ('ok' as const) : ('degraded' as const),
    checkedAt: new Date().toISOString(),
    uptimeSeconds: 100,
    environment: 'test',
    checks: [{ name: 'email', status, summary: 'EMAIL_FROM is on resend.dev' }],
  });

  let sent: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    wd.resetStreaks();
    sent = [];
    jest.spyOn(alert, 'maybeSend').mockImplementation(async (_e, m) => { sent.push(m.title); return true; });
    jest.spyOn(alert, 'clearActive').mockResolvedValue(undefined);
    mockSystemEventFindUnique.mockResolvedValue(null);
    mockSystemEventUpsert.mockImplementation(async ({ where }) => ({
      id: 'evt', fingerprint: where.fingerprint, severity: 'CRITICAL', source: 'health',
      message: 'x', count: 1, lastAlertedAt: null, firstSeenAt: new Date(),
    }));
  });

  afterEach(() => jest.restoreAllMocks());

  test('one failed cycle is recorded but does not alert', async () => {
    mockRunHealthChecks.mockResolvedValue(report('fail'));

    await runWatchdogCycle();

    expect(sent).toHaveLength(0);
    // Still written down — the dashboard shows it immediately.
    expect(mockSystemEventUpsert).toHaveBeenCalled();
  });

  test('a second consecutive failure does alert', async () => {
    mockRunHealthChecks.mockResolvedValue(report('fail'));

    await runWatchdogCycle();
    await runWatchdogCycle();

    expect(sent).toHaveLength(1);
  });

  test('a pass between failures resets the streak', async () => {
    // The Neon case exactly: connection drops, next cycle reconnects. Without
    // the reset, a check that flaps once an hour eventually pages anyway.
    mockRunHealthChecks.mockResolvedValueOnce(report('fail'));
    await runWatchdogCycle();

    mockRunHealthChecks.mockResolvedValueOnce(report('ok'));
    await runWatchdogCycle();

    mockRunHealthChecks.mockResolvedValueOnce(report('fail'));
    await runWatchdogCycle();

    expect(sent).toHaveLength(0);
  });

  test('the threshold is what the environment says it is', () => {
    expect(env.WATCHDOG_ESCALATE_AFTER).toBeGreaterThanOrEqual(2);
  });
});
