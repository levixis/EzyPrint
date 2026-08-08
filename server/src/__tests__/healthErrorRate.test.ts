/**
 * The errors check must not count its own alarm.
 *
 * Every failing health check is escalated by the watchdog as a CRITICAL
 * `system_events` row with `source: 'health'`. The errors check counts
 * unresolved CRITICALs. Counted naively, those two facts form a loop with no
 * exit: one failure writes the `health:errors` row, that row is an unresolved
 * CRITICAL, and the next cycle fails again on the evidence the last one
 * created.
 *
 * This was observed running, not theorised. A dev instance held 8 unresolved
 * criticals, every one of them `source: 'health'` and not one an actual
 * application error, with the offending row's own message reading
 * "8 unresolved critical error(s)".
 *
 * What it costs is the whole subsystem: `status` is pinned at `degraded`
 * forever, the all-clear in `alert.clearActive` can never fire because a check
 * is always failing, and the alert re-sends on its escalating backoff until
 * someone mutes it. A monitor that is always red is one nobody reads — the
 * exact failure the cooldown and the ceiling exist to prevent.
 */

const mockSystemEventCount = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]),
    systemEvent: { count: mockSystemEventCount },
    jobHeartbeat: { findMany: jest.fn().mockResolvedValue([]) },
    order: { count: jest.fn().mockResolvedValue(0) },
    refundRequest: { count: jest.fn().mockResolvedValue(0) },
    realtimeOutbox: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn() },
    ledgerEntry: { count: jest.fn().mockResolvedValue(0) },
    webhookEvent: { count: jest.fn().mockResolvedValue(0) },
  },
}));

jest.mock('../services/storage.service', () => ({ probeStorage: jest.fn() }));
jest.mock('../services/payment.service', () => ({ probeGateway: jest.fn() }));

import { runHealthChecks } from '../services/health.service';

/** The `where` of each systemEvent.count call this run made. */
const countWheres = () => mockSystemEventCount.mock.calls.map((call) => call[0]?.where ?? {});

const errorsCheck = async () => {
  const report = await runHealthChecks();
  return report.checks.find((check) => check.name === 'errors')!;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSystemEventCount.mockResolvedValue(0);
});

describe('the errors check counts application errors, not its own escalations', () => {
  test('every count excludes source "health"', async () => {
    await errorsCheck();

    expect(countWheres().length).toBeGreaterThan(0);
    for (const where of countWheres()) {
      expect(where.source).toEqual({ not: 'health' });
    }
  });

  test('a report full of health escalations and no real errors is ok', async () => {
    // The exact production state that exposed this: the only unresolved
    // criticals are the watchdog's own records of other checks failing. Those
    // checks report themselves in this same report — counting them here says
    // nothing new and cannot be cleared by fixing anything.
    mockSystemEventCount.mockResolvedValue(0);

    const check = await errorsCheck();

    expect(check.status).toBe('ok');
  });

  test('a genuine application error still fails the check', async () => {
    // The exclusion must not be so broad that it silences what this check is
    // for: an unhandled request error, a crashed process, a failing job.
    mockSystemEventCount.mockResolvedValue(2);

    const check = await errorsCheck();

    expect(check.status).toBe('fail');
    expect(check.summary).toContain('2');
  });

  test('the check can recover, which is what the loop prevented', async () => {
    mockSystemEventCount.mockResolvedValue(1);
    expect((await errorsCheck()).status).toBe('fail');

    // The application error is resolved. Nothing about the watchdog having
    // escalated it should hold the check down.
    jest.clearAllMocks();
    mockSystemEventCount.mockResolvedValue(0);

    expect((await errorsCheck()).status).toBe('ok');
  });
});
