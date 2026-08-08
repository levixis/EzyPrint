import type { RemediationOutcome } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { env } from '../config/env';
import { runHealthChecks, type HealthCheck, type HealthReport } from './health.service';
import { dispatchOutbox } from './realtime.service';
import { reconcilePayments, reconcileStuckRefunds } from './payment.service';
import { runSettlementSweep } from './settlement.service';
import { captureError } from './observability.service';
import * as alert from './alert.service';

/**
 * The watchdog — detection, then bounded automatic recovery, then escalation.
 *
 * ═════════════════════════════════════════════════════════════
 * THE SAFETY MODEL
 * ═════════════════════════════════════════════════════════════
 *
 * This code changes production state with no human in the loop, on a system
 * that holds other people's money. That earns a small number of hard rules,
 * and the value of the rules is entirely in refusing to bend them for a
 * remediation that seems obviously fine.
 *
 * 1. IDEMPOTENT ONLY.
 *    Every action must be safe to run twice, ten times, or concurrently with
 *    itself. If running it twice differs from running it once, it does not
 *    belong here. This is what makes a watchdog that fires on a false positive
 *    harmless: the worst case is wasted work, never doubled work.
 *
 * 2. NOTHING DESTRUCTIVE. NOTHING IRREVERSIBLE.
 *    No deletes of business data, no schema changes, no direct writes to
 *    balances, no gateway calls that move money. `sweepUndeletedFiles` is
 *    deliberately NOT wired in here even though it is idempotent and already
 *    runs on a schedule — it destroys objects in R2, and an automated actor
 *    firing on a bad signal cannot un-delete a student's document. Irreversible
 *    and automatic is the combination to avoid; the hourly job keeps doing it
 *    with no watchdog involvement.
 *
 * 3. REPLAY WHAT WAS ALREADY INTENDED. NEVER INVENT STATE.
 *    Each action re-runs work the system had already decided to do and failed
 *    to finish: deliver an event that is already sitting in the outbox, settle
 *    an earning that already has a matured `availableAt`, ask Razorpay about an
 *    order we already created there. The watchdog therefore cannot originate a
 *    payment, an earning or a refund — only finish one. It is a retry, not a
 *    decision-maker.
 *
 * 4. RE-CHECK THE PRECONDITION AT ACTION TIME.
 *    Detection and action are separated by time, and the condition may have
 *    cleared in between — most often because the previous cycle's remediation
 *    worked. Every action re-verifies immediately before acting and returns
 *    SKIPPED if the problem is gone. Acting on a stale reading is the main way
 *    an automated fixer makes things worse.
 *
 * 5. CIRCUIT BREAKER, THEN A HUMAN.
 *    Three consecutive failures of one action opens its circuit: it stops being
 *    attempted and an alert goes out. The failures worth retrying clear inside
 *    three attempts; anything that survives three identical attempts is a
 *    defect that retrying will not fix, and continuing only buries the alert
 *    under its own noise. After a cooldown the circuit half-opens and allows
 *    exactly one trial attempt, which either closes it or re-opens it.
 *
 * 6. BOUNDED BLAST RADIUS.
 *    Every action caps how much it will touch in one run. A remediation that
 *    processes "everything outstanding" is one bad query away from a stampede.
 *
 * 7. EVERY ATTEMPT IS AUDITED.
 *    Success, failure, skip and block all write a `remediation_log` row with
 *    what was seen and what changed. An automated actor that cannot be audited
 *    afterwards is not one you can leave running.
 *
 * 8. THE KILL SWITCH STOPS ACTING, NOT SEEING.
 *    ENABLE_WATCHDOG=false disables remediation and leaves detection, health
 *    reporting and alerting fully intact — the state you want while diagnosing
 *    something the watchdog itself might be implicated in.
 *
 * ═════════════════════════════════════════════════════════════
 */

/** A remediation the watchdog is permitted to perform. */
interface Remediation {
  /** Stable id, written to remediation_log. */
  action: string;
  /** Health check name whose failure triggers this. */
  triggeredBy: string;
  /** Plain description, used in alerts and the dashboard. */
  description: string;
  /**
   * Re-check the condition at action time. Returning false means the problem
   * cleared between detection and now — a skip, not a failure.
   */
  stillNeeded: () => Promise<boolean>;
  /** Do the work. Must be idempotent and non-destructive. Returns detail. */
  run: () => Promise<Record<string, unknown>>;
  /** Minimum gap between two attempts of this action. */
  minIntervalMs: number;
}

// ─────────────────────────────────────────────────────────────
// THE PERMITTED SET
//
// Adding to this list is the security-sensitive act in this file. Anything new
// has to satisfy all eight rules above, not merely be useful.
// ─────────────────────────────────────────────────────────────

const REMEDIATIONS: Remediation[] = [
  {
    action: 'redispatch-outbox',
    triggeredBy: 'realtime_outbox',
    description: 'Re-deliver real-time ledger events that were queued but never published',
    minIntervalMs: 60_000,
    // Idempotent by construction: dispatchOutbox selects on `publishedAt: null`
    // and stamps rows as it delivers, so a second run finds nothing to redo.
    // Delivery is at-least-once by design and the client de-dupes on `seq`.
    stillNeeded: async () => {
      const stuck = await prisma.realtimeOutbox.count({
        where: { publishedAt: null, createdAt: { lt: new Date(Date.now() - 5 * 60 * 1000) } },
      });
      return stuck > 0;
    },
    run: async () => {
      const delivered = await dispatchOutbox(100);
      return { delivered };
    },
  },

  {
    action: 'force-reconciliation',
    triggeredBy: 'stranded_payments',
    description: 'Ask Razorpay about orders that were paid but never advanced',
    minIntervalMs: 5 * 60_000,
    // Safe because it takes Razorpay's record as the truth and applies it
    // through the same compare-and-swap status transitions the webhook uses.
    // It cannot mark an order paid that the gateway does not report as
    // captured, and running it twice converges on the same state.
    stillNeeded: async () => {
      const stranded = await prisma.order.count({
        where: {
          status: { in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] },
          razorpayOrderId: { not: null },
          paymentAttemptedAt: { lt: new Date(Date.now() - 20 * 60 * 1000) },
        },
      });
      return stranded > 0;
    },
    run: async () => {
      const result = await reconcilePayments(20);
      return { ...result };
    },
  },

  {
    action: 'reconcile-refunds',
    triggeredBy: 'stranded_refunds',
    description: 'Ask Razorpay how refunds we are still waiting on actually ended',
    minIntervalMs: 5 * 60_000,
    // Safe by the same argument as force-reconciliation: it reads the gateway's
    // record and applies it through the same status-guarded writes the webhook
    // uses. It cannot originate a refund — `callRazorpayRefund` is not reachable
    // from here — so the worst it can do is finish one that is already in
    // flight, which is precisely rule 3. Bounded to 25 requests per run.
    stillNeeded: async () => {
      const stuck = await prisma.refundRequest.count({
        where: {
          status: 'PROCESSING_REFUND',
          OR: [
            { adminResolvedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
            {
              adminResolvedAt: null,
              studentRequestedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            },
          ],
        },
      });
      return stuck > 0;
    },
    run: async () => {
      const result = await reconcileStuckRefunds({ stuckMinutes: 60, limit: 25 });
      // `stranded` is a list of ids; the log wants a count and the ids both,
      // since those are the ones no retry will ever resolve.
      return { ...result, stranded: result.stranded.length, strandedIds: result.stranded };
    },
  },

  {
    action: 'run-settlement-sweep',
    triggeredBy: 'settlement_backlog',
    description: 'Move matured earnings from clearing into available',
    minIntervalMs: 5 * 60_000,
    // Idempotent: the sweep selects entries whose `availableAt` has passed and
    // whose status is still PENDING, then flips them inside a transaction. A
    // second run sees no PENDING rows and moves nothing. It only advances money
    // along a path already decided when the earning was written — it cannot
    // create an earning or change an amount.
    stillNeeded: async () => {
      const overdue = await prisma.ledgerEntry.count({
        where: {
          type: 'ORDER_EARNING',
          status: 'PENDING',
          availableAt: { not: null, lte: new Date() },
        },
      });
      return overdue > 0;
    },
    run: async () => {
      const result = await runSettlementSweep();
      return { ...result };
    },
  },
];

// ─────────────────────────────────────────────────────────────
// CIRCUIT BREAKER
//
// State is derived from remediation_log rather than held in memory, because
// this host restarts and sleeps constantly and an in-process counter resets on
// every wake — which would mean an action that fails forever gets retried
// forever, never reaching the threshold that escalates it to a person.
// ─────────────────────────────────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half-open';

async function circuitState(action: string): Promise<{ state: CircuitState; failures: number }> {
  const recent = await prisma.remediationLog.findMany({
    where: { action, outcome: { in: ['SUCCEEDED', 'FAILED'] } },
    orderBy: { createdAt: 'desc' },
    take: env.WATCHDOG_CIRCUIT_THRESHOLD,
    select: { outcome: true, createdAt: true },
  });

  let failures = 0;
  for (const entry of recent) {
    if (entry.outcome !== 'FAILED') break;
    failures++;
  }

  if (failures < env.WATCHDOG_CIRCUIT_THRESHOLD) return { state: 'closed', failures };

  // Threshold reached. One trial attempt is allowed once the cooldown expires.
  const lastFailure = recent[0]?.createdAt.getTime() ?? 0;
  const cooled = Date.now() - lastFailure > env.WATCHDOG_CIRCUIT_COOLDOWN_MS;
  return { state: cooled ? 'half-open' : 'open', failures };
}

async function lastAttemptAt(action: string): Promise<number> {
  const last = await prisma.remediationLog.findFirst({
    where: { action },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return last?.createdAt.getTime() ?? 0;
}

async function record(
  action: string,
  trigger: string,
  outcome: RemediationOutcome,
  detail: Record<string, unknown>,
  durationMs: number
): Promise<void> {
  try {
    await prisma.remediationLog.create({
      data: { action, trigger, outcome, detail: detail as never, durationMs },
    });
  } catch (error) {
    // The audit write failing must not stop the remediation from being
    // reported through the other channel.
    console.error('[watchdog] failed to write audit record:', error);
  }
}

// ─────────────────────────────────────────────────────────────
// THE CYCLE
// ─────────────────────────────────────────────────────────────

export interface WatchdogResult {
  report: HealthReport;
  attempted: Array<{ action: string; outcome: RemediationOutcome; detail: Record<string, unknown> }>;
}

/**
 * One full cycle: check, then remediate what is both broken and fixable, then
 * escalate what is not.
 *
 * Ordering matters. Health is evaluated once and the same report drives both
 * remediation and alerting, so an operator's alert describes the same moment
 * the watchdog acted on rather than a second, later reading.
 */
/**
 * Consecutive failures per check, so a one-off does not page anyone.
 *
 * In memory deliberately. A restart clearing it costs at most one extra cycle
 * of grace before escalating, which is the harmless direction to be wrong in —
 * whereas persisting it would mean a database write on the very path that runs
 * when the database is the thing that is broken.
 */
const consecutiveFailures = new Map<string, number>();

/**
 * Checks that cannot be judged while the database is unreachable.
 *
 * Every one of these is a query. When Postgres is gone they all fail together,
 * and escalating each separately turned one dropped connection into four
 * CRITICAL emails describing the same outage from four angles. The database
 * failure is the only one worth telling anyone about; the rest are its shadow.
 */
const DATABASE_DEPENDENT = new Set([
  'scheduler',
  'stranded_payments',
  'stranded_refunds',
  'realtime_outbox',
  'settlement_backlog',
  'webhooks',
  'errors',
]);

export async function runWatchdogCycle(): Promise<WatchdogResult> {
  const report = await runHealthChecks();
  const failing = report.checks.filter((check) => check.status === 'fail');
  const attempted: WatchdogResult['attempted'] = [];

  // Track streaks for every check, not just the failing ones — a pass has to
  // clear the counter or a check that flaps once an hour eventually escalates.
  for (const check of report.checks) {
    if (check.status === 'fail') {
      consecutiveFailures.set(check.name, (consecutiveFailures.get(check.name) ?? 0) + 1);
    } else {
      consecutiveFailures.delete(check.name);
    }
  }

  const databaseDown = report.status === 'down';

  for (const check of failing) {
    // One outage, one alert. The dependent checks still ran, still show as
    // failing on the dashboard, and still count toward their own streaks —
    // they simply do not each send their own email about the same cause.
    if (databaseDown && DATABASE_DEPENDENT.has(check.name)) continue;

    const remediation = REMEDIATIONS.find((r) => r.triggeredBy === check.name);

    // No automatic fix exists for this failure — the correct outcome for
    // config errors, a dead gateway, a broken mail domain. A person is needed.
    if (!remediation) {
      await escalate(check, 'no automatic remediation exists for this condition');
      continue;
    }

    if (!env.ENABLE_WATCHDOG) {
      await escalate(check, 'automatic remediation is disabled (ENABLE_WATCHDOG=false)');
      continue;
    }

    const outcome = await attempt(remediation, check);
    attempted.push(outcome);
  }

  // Nothing failing and the watchdog has been acting: report recovery so the
  // operator learns the thing they were paged about resolved itself.
  if (failing.length === 0) {
    await alert.clearActive(report);
  }

  return { report, attempted };
}

async function attempt(
  remediation: Remediation,
  check: HealthCheck
): Promise<{ action: string; outcome: RemediationOutcome; detail: Record<string, unknown> }> {
  const { action, triggeredBy } = remediation;
  const started = Date.now();

  // ── Rate limit ──
  const sinceLast = Date.now() - (await lastAttemptAt(action));
  if (sinceLast < remediation.minIntervalMs) {
    const detail = { reason: 'rate-limited', sinceLastMs: sinceLast, minIntervalMs: remediation.minIntervalMs };
    return { action, outcome: 'SKIPPED', detail };
  }

  // ── Circuit breaker ──
  const circuit = await circuitState(action);
  if (circuit.state === 'open') {
    const detail = { reason: 'circuit-open', consecutiveFailures: circuit.failures };
    await record(action, triggeredBy, 'BLOCKED', detail, Date.now() - started);
    await escalate(
      check,
      `automatic recovery "${remediation.description}" has failed ${circuit.failures} times in a row and has been stopped`
    );
    return { action, outcome: 'BLOCKED', detail };
  }

  // ── Precondition re-check ──
  // The gap between detection and action is where a previous cycle's fix lands.
  try {
    if (!(await remediation.stillNeeded())) {
      const detail = { reason: 'condition-cleared-before-action' };
      await record(action, triggeredBy, 'SKIPPED', detail, Date.now() - started);
      return { action, outcome: 'SKIPPED', detail };
    }
  } catch (error) {
    const detail = { reason: 'precondition-check-failed', error: String(error) };
    await record(action, triggeredBy, 'FAILED', detail, Date.now() - started);
    return { action, outcome: 'FAILED', detail };
  }

  // ── Act ──
  try {
    const detail = await remediation.run();
    const durationMs = Date.now() - started;
    await record(action, triggeredBy, 'SUCCEEDED', detail, durationMs);

    console.log(`[watchdog] ${action} succeeded:`, JSON.stringify(detail));

    // A half-open circuit that just succeeded is closed again, and the operator
    // who was told it had been stopped is told it recovered.
    if (circuit.state === 'half-open') {
      await alert.send({
        severity: 'INFO',
        title: `Recovered: ${remediation.description}`,
        body:
          `"${action}" succeeded after previously failing ${circuit.failures} times. ` +
          `Automatic recovery is active again.`,
        fingerprint: `watchdog-recovered-${action}`,
      });
    }

    return { action, outcome: 'SUCCEEDED', detail };
  } catch (error) {
    const durationMs = Date.now() - started;
    const detail = { error: error instanceof Error ? error.message : String(error) };
    await record(action, triggeredBy, 'FAILED', detail, durationMs);

    await captureError({
      source: 'watchdog',
      severity: 'ERROR',
      message: `Remediation "${action}" failed: ${detail.error}`,
      context: { action, triggeredBy, check: check.summary },
      error,
    });

    return { action, outcome: 'FAILED', detail };
  }
}

/**
 * Hand a failing check to a human.
 *
 * Routed through captureError first so it lands in system_events with the same
 * fingerprinting and deduplication as everything else — a failing check on a
 * two-minute cycle would otherwise be 30 alerts an hour, and an alert channel
 * that produces 30 an hour is one that gets muted.
 */
async function escalate(check: HealthCheck, reason: string): Promise<void> {
  // Lets the next quiet cycle know it has an all-clear worth sending.
  alert.noteFailure();

  const streak = consecutiveFailures.get(check.name) ?? 1;

  const event = await captureError({
    source: 'health',
    severity: 'CRITICAL',
    message: `[${check.name}] ${check.summary}`,
    context: { check: check.name, reason, consecutiveFailures: streak, ...check.detail },
    /**
     * Identity is the check, not this minute's wording.
     *
     * Health summaries deliberately carry live numbers — "last success 39m
     * ago", "3 orders stranded" — so deriving a fingerprint from the message
     * produced a different one every cycle. Each looked like a brand-new
     * fault, and a brand-new fault is exempt from the cooldown by design, so
     * one stuck job emailed every two minutes. The check name is what is
     * actually broken and it does not change.
     */
    fingerprintKey: `health:${check.name}`,
  });

  if (!event) return;

  // Below the threshold this is recorded and visible on the dashboard, but
  // nobody is woken. Transient database blips resolve inside one cycle.
  if (streak < env.WATCHDOG_ESCALATE_AFTER) return;

  await alert.maybeSend(event, {
    title: `EzyPrint: ${check.name.replace(/_/g, ' ')} is failing`,
    body:
      `${check.summary}\n\n` +
      `Failing for ${streak} consecutive checks.\n` +
      `Why you are being told: ${reason}.`,
  });
}

// ─────────────────────────────────────────────────────────────
// LIFECYCLE
// ─────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let cycleRunning = false;

export function startWatchdog(): void {
  if (env.isTest) return;

  const tick = async () => {
    // A slow cycle must not overlap itself: two concurrent cycles would each
    // see the same failure and each fire a remediation, which is exactly the
    // doubled-work case rule 1 exists to prevent.
    if (cycleRunning) return;
    cycleRunning = true;
    try {
      await runWatchdogCycle();
    } catch (error) {
      console.error('[watchdog] cycle failed:', error);
      await captureError({
        source: 'watchdog',
        severity: 'ERROR',
        message: 'Watchdog cycle itself threw',
        error,
      });
    } finally {
      cycleRunning = false;
    }
  };

  timer = setInterval(tick, env.WATCHDOG_INTERVAL_MS);
  timer.unref();

  console.log(
    `[watchdog] started — checking every ${env.WATCHDOG_INTERVAL_MS}ms, ` +
    `remediation ${env.ENABLE_WATCHDOG ? 'ENABLED' : 'DISABLED (detect and alert only)'}`
  );
}

export function stopWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  consecutiveFailures.clear();
}

/** Exposed for the admin dashboard, so an operator can see what is permitted. */
export function listRemediations() {
  return REMEDIATIONS.map((r) => ({
    action: r.action,
    triggeredBy: r.triggeredBy,
    description: r.description,
    minIntervalMs: r.minIntervalMs,
  }));
}

export const __testing = {
  circuitState,
  REMEDIATIONS,
  resetStreaks: () => consecutiveFailures.clear(),
};
