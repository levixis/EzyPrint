/**
 * A host that sleeps must not silently stop running the long jobs.
 *
 * `setInterval` alone means every job waits a full interval after boot before
 * its first run. On an always-on host that is invisible. Render's free tier
 * suspends the instance after about fifteen minutes idle, so any job whose
 * interval exceeds the awake window never ran at all — payment-audit and
 * file-retention are hourly, which made them dead code on that plan. The audit
 * is the safety net that catches a captured payment with no order, the class of
 * failure that cost a real ₹5 order to a database restore.
 *
 * That is survivable because none of these jobs is a fire-at-a-moment cron.
 * Every one selects outstanding work by predicate — settlement takes anything
 * whose `availableAt` has passed, outbox anything unpublished — so running late
 * costs delay, not correctness, and running on wake is enough.
 *
 * What these tests pin is the pair of guards that keep "run on wake" from
 * becoming its own stampede.
 */

const mockHeartbeatFindUnique = jest.fn();
const mockHeartbeatUpsert = jest.fn();
const mockQueryRaw = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    jobHeartbeat: { findUnique: mockHeartbeatFindUnique, upsert: mockHeartbeatUpsert },
    $queryRaw: mockQueryRaw,
  },
}));

// ENABLE_SCHEDULER defaults to `!isTest`, so under NODE_ENV=test the real
// config turns the scheduler off and `startScheduler` returns before
// registering anything. Everything else is left as configured, so the jobs
// keep their real intervals — the point of these tests is how a long interval
// behaves, and substituting a short one would test the substitute.
jest.mock('../config/env', () => {
  const actual = jest.requireActual('../config/env');
  return { ...actual, env: { ...actual.env, ENABLE_SCHEDULER: true } };
});

// Every job the scheduler registers, stubbed to a no-op. This suite is about
// *whether* work is dispatched on boot, never about what the work does.
const mockRunSettlementSweep = jest.fn().mockResolvedValue({ shopsSettled: 0, entriesSettled: 0, amountSettled: 0 });
const mockDispatchOutbox = jest.fn().mockResolvedValue(0);

jest.mock('../services/settlement.service', () => ({ runSettlementSweep: mockRunSettlementSweep }));
jest.mock('../services/payment.service', () => ({
  reconcilePayments: jest.fn().mockResolvedValue({ checked: 0, reconciled: 0, retriedWebhooks: 0 }),
  auditCapturedPayments: jest.fn().mockResolvedValue({ orphans: [] }),
  reconcileStuckRefunds: jest.fn().mockResolvedValue({ checked: 0, confirmed: 0, failed: 0, stillPending: 0, stranded: [], errors: 0 }),
}));
jest.mock('../services/realtime.service', () => ({
  dispatchOutbox: mockDispatchOutbox,
  pruneOutbox: jest.fn().mockResolvedValue(0),
}));
jest.mock('../services/cleanup.service', () => ({ sweepUndeletedFiles: jest.fn().mockResolvedValue({ filesRemoved: 0, ordersPurged: 0, ticketsPurged: 0 }) }));
jest.mock('../services/referral.service', () => ({ sweepExpiredReferralCodes: jest.fn().mockResolvedValue(0) }));
jest.mock('../services/notify.service', () => ({ notifyAdmins: jest.fn() }));
jest.mock('../services/observability.service', () => ({
  recordJobStart: jest.fn().mockResolvedValue(undefined),
  recordJobSuccess: jest.fn().mockResolvedValue(undefined),
  recordJobFailure: jest.fn().mockResolvedValue(undefined),
  sweepOldEvents: jest.fn().mockResolvedValue({ events: 0, remediations: 0 }),
}));

import { startScheduler, stopScheduler } from '../services/scheduler.service';

const HOUR = 60 * 60 * 1000;

/** Advance past the stagger so every job's catch-up timer has fired. */
const runCatchUps = async () => {
  jest.advanceTimersByTime(60_000);
  // Each catch-up awaits a heartbeat read before deciding; let those settle.
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  // The advisory lock every job takes before doing work. `withAdvisoryLock`
  // destructures `{ locked }` — the SQL alias, not the function name.
  mockQueryRaw.mockResolvedValue([{ locked: true }]);
  mockHeartbeatUpsert.mockResolvedValue({});
});

afterEach(() => {
  stopScheduler();
  jest.useRealTimers();
});

describe('catch-up on boot', () => {
  test('an overdue job runs without waiting a full interval', async () => {
    // The case that made hourly jobs dead code on a sleeping host: the
    // instance wakes, and under the old behaviour nothing would run for an
    // hour — by which time it is asleep again.
    mockHeartbeatFindUnique.mockResolvedValue({
      lastSucceededAt: new Date(Date.now() - 4 * HOUR),
      consecutiveFailures: 0,
    });

    startScheduler();
    await runCatchUps();

    expect(mockRunSettlementSweep).toHaveBeenCalled();
  });

  test('a job that has never run is treated as owed', async () => {
    // A fresh database, or a job added in this deploy. No heartbeat row at all.
    mockHeartbeatFindUnique.mockResolvedValue(null);

    startScheduler();
    await runCatchUps();

    expect(mockRunSettlementSweep).toHaveBeenCalled();
  });

  test('a job that ran recently is not re-run', async () => {
    // The guard against a restart loop re-running an hourly audit on every
    // boot. Nothing is owed if the last success is inside the interval.
    mockHeartbeatFindUnique.mockResolvedValue({
      lastSucceededAt: new Date(Date.now() - 1000),
      consecutiveFailures: 0,
    });

    startScheduler();
    await runCatchUps();

    expect(mockRunSettlementSweep).not.toHaveBeenCalled();
  });

  test('a job with a failure streak forfeits its catch-up', async () => {
    // Overdue by the success clock — which a persistently failing job always
    // is, since failures never stamp `lastSucceededAt`. Without this guard a
    // crash loop would retry it on every boot, hammering whatever external
    // service it is failing against. The normal interval still applies.
    mockHeartbeatFindUnique.mockResolvedValue({
      lastSucceededAt: new Date(Date.now() - 4 * HOUR),
      consecutiveFailures: 3,
    });

    startScheduler();
    await runCatchUps();

    expect(mockRunSettlementSweep).not.toHaveBeenCalled();
  });

  test('a failing heartbeat read does not take the boot down', async () => {
    // This runs during startup. An unhandled rejection here would be a crash
    // loop caused by the code meant to survive one.
    mockHeartbeatFindUnique.mockRejectedValue(new Error('Server has closed the connection'));

    startScheduler();

    await expect(runCatchUps()).resolves.not.toThrow();
    expect(mockRunSettlementSweep).not.toHaveBeenCalled();
  });

  test('jobs are staggered rather than fired together', async () => {
    // A cold start is when the Neon connection is still being established.
    // Eight sweeps at once turns a slow wake into a failed one.
    mockHeartbeatFindUnique.mockResolvedValue({ lastSucceededAt: null, consecutiveFailures: 0 });

    startScheduler();

    // Before the first delay elapses, nothing has been dispatched at all.
    jest.advanceTimersByTime(1_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockHeartbeatFindUnique).not.toHaveBeenCalled();

    await runCatchUps();
    expect(mockHeartbeatFindUnique).toHaveBeenCalled();
  });

  test('a second start does not push the stagger further out', async () => {
    // `catchUpSlot` is module state. Without resetting it per start, a
    // stop/start inside one process would schedule the next boot's first
    // catch-up further and further into the future until it never fired.
    mockHeartbeatFindUnique.mockResolvedValue({ lastSucceededAt: null, consecutiveFailures: 0 });

    startScheduler();
    await runCatchUps();
    const firstRun = mockHeartbeatFindUnique.mock.calls.length;

    stopScheduler();
    jest.clearAllMocks();
    mockHeartbeatFindUnique.mockResolvedValue({ lastSucceededAt: null, consecutiveFailures: 0 });
    mockQueryRaw.mockResolvedValue([{ locked: true }]);

    startScheduler();
    await runCatchUps();

    expect(mockHeartbeatFindUnique.mock.calls.length).toBe(firstRun);
  });
});
