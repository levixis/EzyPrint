/**
 * Unit Tests — the watchdog's safety rules.
 *
 * This is the one component in the system that changes production state with no
 * human in the loop, on an app that holds other people's money. The tests that
 * matter are therefore not "does it fix things" but "can it be trusted not to
 * make things worse":
 *
 *   • it re-checks the problem still exists immediately before acting, so a
 *     stale reading cannot drive an action;
 *   • it stops after repeated failure instead of retrying forever, and tells a
 *     person;
 *   • the kill switch stops it acting while leaving it seeing;
 *   • and every action in the permitted set is idempotent and non-destructive.
 *
 * The last one is enforced structurally rather than by reading: a test asserts
 * the catalogue itself, so adding a destructive remediation fails CI rather
 * than passing review.
 */

const mockRemediationFindMany = jest.fn().mockResolvedValue([]);
const mockRemediationFindFirst = jest.fn().mockResolvedValue(null);
const mockRemediationCreate = jest.fn().mockResolvedValue({});
const mockOrderCount = jest.fn().mockResolvedValue(0);
const mockLedgerCount = jest.fn().mockResolvedValue(0);
const mockOutboxCount = jest.fn().mockResolvedValue(0);

jest.mock('../utils/prisma', () => ({
  prisma: {
    remediationLog: {
      findMany: mockRemediationFindMany,
      findFirst: mockRemediationFindFirst,
      create: mockRemediationCreate,
    },
    order: { count: mockOrderCount },
    ledgerEntry: { count: mockLedgerCount },
    realtimeOutbox: { count: mockOutboxCount },
  },
}));

const mockRunHealthChecks = jest.fn();
jest.mock('../services/health.service', () => ({
  runHealthChecks: mockRunHealthChecks,
}));

const mockDispatchOutbox = jest.fn().mockResolvedValue(0);
jest.mock('../services/realtime.service', () => ({ dispatchOutbox: mockDispatchOutbox }));

const mockReconcile = jest.fn().mockResolvedValue({ checked: 0, reconciled: 0 });
jest.mock('../services/payment.service', () => ({ reconcilePayments: mockReconcile }));

const mockSettlementSweep = jest.fn().mockResolvedValue({ shopsSettled: 0, entriesSettled: 0, amountSettled: 0 });
jest.mock('../services/settlement.service', () => ({ runSettlementSweep: mockSettlementSweep }));

const mockCaptureError = jest.fn().mockResolvedValue({
  id: 'evt-1',
  fingerprint: 'fp-1',
  severity: 'CRITICAL',
  source: 'health',
  message: 'boom',
  count: 1,
  isNew: true,
  lastAlertedAt: null,
});
jest.mock('../services/observability.service', () => ({ captureError: mockCaptureError }));

const mockAlertSend = jest.fn().mockResolvedValue(undefined);
const mockMaybeSend = jest.fn().mockResolvedValue(true);
const mockNoteFailure = jest.fn();
const mockClearActive = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/alert.service', () => ({
  send: mockAlertSend,
  maybeSend: mockMaybeSend,
  noteFailure: mockNoteFailure,
  clearActive: mockClearActive,
}));

import { runWatchdogCycle, listRemediations, __testing } from '../services/watchdog.service';
import { env } from '../config/env';

const { circuitState, REMEDIATIONS } = __testing;

/** A health report with one named check failing. */
const failing = (name: string, summary = 'something is wrong') => ({
  status: 'degraded' as const,
  checkedAt: new Date().toISOString(),
  uptimeSeconds: 100,
  environment: 'test',
  checks: [{ name, status: 'fail' as const, summary }],
});

const allGood = () => ({
  status: 'ok' as const,
  checkedAt: new Date().toISOString(),
  uptimeSeconds: 100,
  environment: 'test',
  checks: [{ name: 'database', status: 'ok' as const, summary: 'Connected.' }],
});

beforeEach(() => {
  jest.clearAllMocks();
  // Consecutive-failure counts live in module state so a transient blip does
  // not page anyone. Left uncleared, a test needing two failing cycles would
  // pass off the back of a previous test's streak.
  __testing.resetStreaks();
  mockRemediationFindMany.mockResolvedValue([]);
  mockRemediationFindFirst.mockResolvedValue(null);
  mockOrderCount.mockResolvedValue(0);
  mockLedgerCount.mockResolvedValue(0);
  mockOutboxCount.mockResolvedValue(0);
  mockDispatchOutbox.mockResolvedValue(0);

  // ENABLE_WATCHDOG defaults to `!isTest`, so remediation is OFF under jest —
  // which is the right default (a test run must never act on anything) and
  // exactly what the kill-switch case below verifies. The tests that exercise
  // the acting path have to opt in explicitly.
  (env as { ENABLE_WATCHDOG: boolean }).ENABLE_WATCHDOG = true;
});

describe('the permitted set', () => {
  test('every remediation declares a trigger, a description and a rate limit', () => {
    for (const remediation of REMEDIATIONS) {
      expect(remediation.action).toBeTruthy();
      expect(remediation.triggeredBy).toBeTruthy();
      expect(remediation.description).toBeTruthy();
      expect(remediation.minIntervalMs).toBeGreaterThan(0);
    }
  });

  test('no two remediations claim the same action id', () => {
    const ids = REMEDIATIONS.map((r) => r.action);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the catalogue is exactly the four reviewed actions', () => {
    // A guard on the blast radius itself. Widening what an unattended process
    // may do to production should be a deliberate edit to this list with a
    // reviewer looking at it, not something that arrives with a feature.
    //
    // `reconcile-refunds` was added deliberately. It reads Razorpay's record of
    // a refund already in flight and applies it through the same status-guarded
    // writes the webhook uses; it has no path to `callRazorpayRefund`, so it can
    // finish a refund but never start one.
    expect(listRemediations().map((r) => r.action).sort()).toEqual([
      'force-reconciliation',
      'reconcile-refunds',
      'redispatch-outbox',
      'run-settlement-sweep',
    ]);
  });

  test('no remediation can originate a refund', () => {
    // The one power that must never be automatic: sending money out. The
    // watchdog may confirm a refund the gateway already holds, and that is the
    // whole of its authority here.
    const source = REMEDIATIONS.map((r) => r.run.toString()).join('\n');
    expect(source).not.toMatch(/callRazorpayRefund|settleClaimedRefund|shopRefundOrder/);
  });

  test('no remediation deletes anything', () => {
    // Rule 2: nothing destructive, nothing irreversible. `sweepUndeletedFiles`
    // is idempotent and already scheduled, and is still deliberately excluded —
    // an automated actor firing on a bad signal cannot un-delete a student's
    // document.
    const source = REMEDIATIONS.map((r) => r.run.toString()).join('\n');
    expect(source).not.toMatch(/delete|destroy|drop|truncate|purge|sweepUndeleted/i);
  });
});

describe('precondition re-check', () => {
  test('skips without acting when the problem cleared between check and action', async () => {
    mockRunHealthChecks.mockResolvedValue(failing('realtime_outbox'));
    mockOutboxCount.mockResolvedValue(0); // cleared — most often by the last cycle

    const { attempted } = await runWatchdogCycle();

    expect(attempted[0]).toMatchObject({ action: 'redispatch-outbox', outcome: 'SKIPPED' });
    expect(mockDispatchOutbox).not.toHaveBeenCalled();
  });

  test('acts when the problem is still there', async () => {
    mockRunHealthChecks.mockResolvedValue(failing('realtime_outbox'));
    mockOutboxCount.mockResolvedValue(7);
    mockDispatchOutbox.mockResolvedValue(7);

    const { attempted } = await runWatchdogCycle();

    expect(attempted[0]).toMatchObject({ action: 'redispatch-outbox', outcome: 'SUCCEEDED' });
    expect(mockDispatchOutbox).toHaveBeenCalled();
  });

  test('a failing precondition check is a failure, not a licence to act', async () => {
    mockRunHealthChecks.mockResolvedValue(failing('settlement_backlog'));
    mockLedgerCount.mockRejectedValue(new Error('db unreachable'));

    const { attempted } = await runWatchdogCycle();

    expect(attempted[0].outcome).toBe('FAILED');
    expect(mockSettlementSweep).not.toHaveBeenCalled();
  });
});

describe('circuit breaker', () => {
  test('stays closed below the threshold', async () => {
    mockRemediationFindMany.mockResolvedValue([
      { outcome: 'FAILED', createdAt: new Date() },
      { outcome: 'SUCCEEDED', createdAt: new Date() },
    ]);

    const state = await circuitState('redispatch-outbox');
    expect(state.state).toBe('closed');
    expect(state.failures).toBe(1);
  });

  test('a success resets the streak — failures must be consecutive', async () => {
    mockRemediationFindMany.mockResolvedValue([
      { outcome: 'FAILED', createdAt: new Date() },
      { outcome: 'FAILED', createdAt: new Date() },
      { outcome: 'SUCCEEDED', createdAt: new Date() },
    ]);

    const state = await circuitState('redispatch-outbox');
    expect(state.failures).toBe(2);
    expect(state.state).toBe('closed');
  });

  test('opens at the threshold and blocks further attempts', async () => {
    const now = new Date();
    mockRemediationFindMany.mockResolvedValue(
      Array.from({ length: env.WATCHDOG_CIRCUIT_THRESHOLD }, () => ({
        outcome: 'FAILED',
        createdAt: now,
      }))
    );
    mockRunHealthChecks.mockResolvedValue(failing('realtime_outbox'));
    mockOutboxCount.mockResolvedValue(7);

    const { attempted } = await runWatchdogCycle();

    expect(attempted[0].outcome).toBe('BLOCKED');
    expect(mockDispatchOutbox).not.toHaveBeenCalled();
  });

  test('an open circuit escalates to a human rather than failing quietly', async () => {
    const now = new Date();
    mockRemediationFindMany.mockResolvedValue(
      Array.from({ length: env.WATCHDOG_CIRCUIT_THRESHOLD }, () => ({ outcome: 'FAILED', createdAt: now }))
    );
    mockRunHealthChecks.mockResolvedValue(failing('realtime_outbox'));
    mockOutboxCount.mockResolvedValue(7);

    // Twice: escalation waits for a confirmed failure rather than a blip.
    await runWatchdogCycle();
    await runWatchdogCycle();

    expect(mockCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'CRITICAL' })
    );
    expect(mockMaybeSend).toHaveBeenCalled();
  });

  test('half-opens for one trial attempt after the cooldown', async () => {
    const longAgo = new Date(Date.now() - env.WATCHDOG_CIRCUIT_COOLDOWN_MS - 60_000);
    mockRemediationFindMany.mockResolvedValue(
      Array.from({ length: env.WATCHDOG_CIRCUIT_THRESHOLD }, () => ({ outcome: 'FAILED', createdAt: longAgo }))
    );

    const state = await circuitState('redispatch-outbox');
    expect(state.state).toBe('half-open');
  });
});

describe('rate limiting', () => {
  test('will not re-attempt the same action inside its minimum interval', async () => {
    mockRunHealthChecks.mockResolvedValue(failing('realtime_outbox'));
    mockOutboxCount.mockResolvedValue(7);
    mockRemediationFindFirst.mockResolvedValue({ createdAt: new Date() }); // just ran

    const { attempted } = await runWatchdogCycle();

    expect(attempted[0]).toMatchObject({ outcome: 'SKIPPED' });
    expect(attempted[0].detail).toMatchObject({ reason: 'rate-limited' });
    expect(mockDispatchOutbox).not.toHaveBeenCalled();
  });
});

describe('escalation', () => {
  test('a failure with no matching remediation reaches a human once confirmed', async () => {
    // Config errors, a dead gateway, a broken mail domain — nothing here is
    // safely fixable by a machine, and pretending otherwise is the failure mode
    // this whole design is arranged to avoid.
    //
    // "Once confirmed" rather than immediately: escalation waits for
    // WATCHDOG_ESCALATE_AFTER consecutive failures, because paging on a single
    // cycle meant paging on Neon closing an idle connection.
    mockRunHealthChecks.mockResolvedValue(failing('email', 'EMAIL_FROM is on resend.dev'));

    await runWatchdogCycle();
    const { attempted } = await runWatchdogCycle();

    expect(attempted).toHaveLength(0);
    expect(mockMaybeSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: expect.stringContaining('email') })
    );
  });

  test('sends an all-clear when everything passes again', async () => {
    mockRunHealthChecks.mockResolvedValue(allGood());
    await runWatchdogCycle();
    expect(mockClearActive).toHaveBeenCalled();
  });
});

describe('kill switch', () => {
  test('ENABLE_WATCHDOG=false stops it acting but not seeing', async () => {
    (env as { ENABLE_WATCHDOG: boolean }).ENABLE_WATCHDOG = false;
    mockRunHealthChecks.mockResolvedValue(failing('realtime_outbox'));
    mockOutboxCount.mockResolvedValue(7);

    await runWatchdogCycle();
    const { report, attempted } = await runWatchdogCycle();

    // Nothing was done…
    expect(attempted).toHaveLength(0);
    expect(mockDispatchOutbox).not.toHaveBeenCalled();
    // …and everything was still observed and reported.
    expect(report.checks[0].status).toBe('fail');
    expect(mockMaybeSend).toHaveBeenCalled();
  });
});

describe('auditing', () => {
  test('every attempt writes a remediation_log row', async () => {
    mockRunHealthChecks.mockResolvedValue(failing('realtime_outbox'));
    mockOutboxCount.mockResolvedValue(7);

    await runWatchdogCycle();

    expect(mockRemediationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'redispatch-outbox',
          trigger: 'realtime_outbox',
          outcome: 'SUCCEEDED',
        }),
      })
    );
  });

  test('a failed action is audited too, with the reason', async () => {
    mockRunHealthChecks.mockResolvedValue(failing('realtime_outbox'));
    mockOutboxCount.mockResolvedValue(7);
    mockDispatchOutbox.mockRejectedValue(new Error('pusher unreachable'));

    await runWatchdogCycle();

    expect(mockRemediationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: 'FAILED',
          detail: expect.objectContaining({ error: 'pusher unreachable' }),
        }),
      })
    );
  });
});
