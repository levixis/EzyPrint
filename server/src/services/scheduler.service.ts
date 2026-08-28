import { prisma } from '../utils/prisma';
import { env } from '../config/env';
import { runSettlementSweep } from './settlement.service';
import { reconcilePayments, auditCapturedPayments, reconcileStuckRefunds } from './payment.service';
import * as notify from './notify.service';
import { dispatchOutbox, pruneOutbox } from './realtime.service';
import { sweepUndeletedFiles } from './cleanup.service';
import { expireStaleUnpaidOrders, abandonExpiredPassCheckouts } from './payment.service';
import { sweepExpiredReferralCodes } from './referral.service';
import { cleanupExpiredTokens } from './token.service';
import { sweepExpiredOtps } from './otp.service';
import { sweepReadNotifications } from './notification.service';
import {
  recordJobStart,
  recordJobSuccess,
  recordJobFailure,
  sweepOldEvents,
} from './observability.service';

/**
 * In-process background jobs.
 *
 * The reconciliation job previously existed only as an admin-triggered HTTP
 * endpoint with a comment claiming an external cron called it every 15 minutes.
 * Nothing did, so a dropped webhook stranded a paid order in PENDING_PAYMENT
 * permanently. These intervals are what actually make it run.
 *
 * Every job takes a lease on its `job_heartbeats` row for its duration, so if a
 * second replica is ever started only one instance runs each job. The lease
 * carries its own expiry, so a crashed instance delays a job by at most
 * its own lease rather than blocking it forever — see `acquireJobLease` for why
 * this is a lease rather than the Postgres advisory lock it used to be.
 */

/**
 * Ceiling on how long a lease is held before another instance may take it over.
 *
 * Generous relative to any job here — the longest is the refund reconcile,
 * which makes up to 50 sequential gateway calls. A lease that expires while its
 * job is still running does not corrupt anything (every job is a guarded,
 * idempotent sweep), it just allows a second instance to start the same work,
 * so the cost of being generous is only latency after a crash.
 *
 * The actual duration is per job — see `leaseDurationFor`, which scales it to
 * the interval so a ten-second job is not stranded for a quarter of an hour.
 */
const JOB_LEASE_MS = 15 * 60 * 1000;

/** Identifies this process in a lease, so it only ever releases its own. */
const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Take the job's lease, or report that another instance holds it.
 *
 * Split out of a `withJobLease(name, work)` wrapper that returned `null` for the
 * contended case. Every job body treated that null as "nothing to log" and
 * returned normally, so `tick` could not tell it apart from a completed run and
 * stamped `recordJobSuccess` anyway — a heartbeat claiming a job finished when
 * it had never started. That heartbeat is the *only* signal that a job is alive:
 * the watchdog reads it for stalls, and `scheduleCatchUp` reads it to decide
 * whether work is owed on boot. So a crashed instance's stale lease produced
 * ticks that quietly reset both, and the catch-up run that exists to rescue a
 * job on a sleeping host skipped because the job "had just succeeded".
 *
 * `schedule` now owns the lease and writes no heartbeat at all when it does not
 * hold it.
 *
 * This replaces a Postgres session-level advisory lock, which was unsafe here
 * for two independent reasons.
 *
 * The first is correctness: `pg_try_advisory_lock` and `pg_advisory_unlock` are
 * scoped to a *session*, and at runtime the app connects through Neon's
 * PgBouncer pooler, where consecutive statements are not guaranteed the same
 * backend. The unlock could land on a connection that did not hold the lock,
 * return false, and leave it held forever — after which every subsequent run
 * saw "not acquired" and returned null, which this function treats as the
 * ordinary contended case. Settlement, reconciliation, the payment audit and
 * file retention would all have stopped, silently, with nothing logged.
 *
 * The second rules out the obvious fix. A transaction-scoped
 * `pg_advisory_xact_lock` is released correctly, but only holds for the life of
 * a transaction — so the job would have to run inside one, pinning a pooled
 * connection for its whole duration. Several of these jobs open transactions of
 * their own while running, and with `connection_limit=10` a handful of
 * overlapping jobs each holding a connection while waiting for another is a
 * pool deadlock.
 *
 * A lease row costs no held connection and expires by itself, so a killed
 * process delays a job by at most `JOB_LEASE_MS` instead of stopping it
 * permanently. The compare-and-swap is the `lockedUntil` predicate: only one
 * caller's `updateMany` can match a free-or-expired lease.
 */
async function acquireJobLease(name: string, leaseMs: number): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + leaseMs);

  const taken = await prisma.jobHeartbeat.updateMany({
    where: {
      name,
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: { lockedUntil: until, lockedBy: INSTANCE_ID },
  });

  if (taken.count > 0) return true;

  // Either someone holds a live lease, or the row does not exist yet.
  // `recordJobStart` creates it, but it swallows its own failures by design — so
  // depending on that having worked would reintroduce exactly the failure being
  // fixed here: a job that never runs again and says nothing about it.
  const exists = await prisma.jobHeartbeat.findUnique({
    where: { name },
    select: { name: true },
  });
  if (exists) return false;

  try {
    await prisma.jobHeartbeat.create({
      data: { name, lockedUntil: until, lockedBy: INSTANCE_ID },
    });
    return true;
  } catch {
    // Another instance created the row first, which means it holds the lease.
    return false;
  }
}

/**
 * Release this instance's own lease.
 *
 * Scoped to `INSTANCE_ID`: if ours already expired and another instance took
 * over, releasing would hand the job to a third.
 */
async function releaseJobLease(name: string): Promise<void> {
  await prisma.jobHeartbeat
    .updateMany({
      where: { name, lockedBy: INSTANCE_ID },
      data: { lockedUntil: null, lockedBy: null },
    })
    .catch((error) => {
      // The lease expires on its own, so a failed release costs a delay rather
      // than a stuck job. Worth saying out loud all the same.
      console.error(`[scheduler] could not release the ${name} lease:`, error);
    });
}

/**
 * How long this job's lease is held before another instance may take it over.
 *
 * Scaled to the job rather than fixed, because the intervals here span ten
 * seconds (outbox) to twenty-four hours (referral sweep) and one number cannot
 * serve both. A crashed process delays a job by at most its lease, so a fixed
 * fifteen minutes meant a killed instance stopped real-time delivery for fifteen
 * minutes — ninety missed ticks of a ten-second job.
 *
 * Three intervals tolerates a slow run without a second instance stealing the
 * job mid-flight; the floor keeps a fast job's lease long enough to cover one
 * run, and the ceiling is the old fixed value.
 */
function leaseDurationFor(intervalMs: number): number {
  return Math.min(JOB_LEASE_MS, Math.max(intervalMs * 3, 60_000));
}

const timers: NodeJS.Timeout[] = [];

/**
 * Schedule `job` on an interval, guarded so a slow run cannot overlap itself.
 */
function schedule(name: string, intervalMs: number, job: () => Promise<void>): void {
  let running = false;
  const leaseMs = leaseDurationFor(intervalMs);

  const tick = async () => {
    if (running) return;
    running = true;

    try {
      // The lease is taken before any heartbeat is written, and a tick that does
      // not hold it writes nothing. Losing the lease is not a run and not a
      // failure — it is this instance having nothing to do — and recording
      // either would corrupt the one signal that says whether the job is alive.
      if (!(await acquireJobLease(name, leaseMs))) return;

      const started = Date.now();

      // Every run that actually runs writes a heartbeat. This is what makes "the
      // scheduler stopped" detectable at all: the logs record that a job
      // *started*, and only the heartbeat records that it finished. On a host
      // that sleeps, a job that silently stops running is otherwise
      // indistinguishable from one that runs and finds nothing to do — and the
      // consequences (earnings that never mature, payments never recovered)
      // surface days later as a support ticket.
      await recordJobStart(name);

      try {
        await job();
        await recordJobSuccess(name, Date.now() - started);
      } catch (error) {
        // A failing job must never take the process down; the next tick retries.
        console.error(`[scheduler] ${name} failed:`, error);
        await recordJobFailure(name, error);
      } finally {
        await releaseJobLease(name);
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Do not keep the event loop alive purely for a background job.
  timer.unref();
  timers.push(timer);

  scheduleCatchUp(name, intervalMs, tick);
}

/**
 * Delay before the first catch-up run, and the gap between successive jobs.
 *
 * Staggered rather than simultaneous: a cold start is exactly when the Neon
 * connection is being established and the first requests are queuing, and
 * firing eight sweeps into that at once turns a slow wake into a failed one.
 */
const CATCH_UP_DELAY_MS = 5_000;
const CATCH_UP_STAGGER_MS = 3_000;

/** Consecutive failures after which a job forfeits its catch-up run. */
const CATCH_UP_FAILURE_LIMIT = 3;

/** Position in the stagger, reset each time the scheduler starts. */
let catchUpSlot = 0;

/**
 * Run a job once shortly after boot if it is overdue.
 *
 * `setInterval` alone means every job waits a full interval after start before
 * its first run. On an always-on host that is invisible. On one that sleeps —
 * Render's free tier stops the instance after about fifteen minutes idle — it
 * means any job whose interval is longer than the awake window never runs at
 * all. payment-audit and file-retention are hourly, so on a sleeping instance
 * they were dead code: the safety net that catches a captured payment with no
 * order would never once have executed.
 *
 * With this, any request that wakes the instance also settles whatever is
 * overdue. Every job here is a catch-up sweep rather than a fire-at-a-moment
 * cron — they select outstanding work by predicate — so running late costs
 * delay, not correctness, and running on wake is enough.
 *
 * Two guards keep this from becoming a stampede of its own:
 *
 *  - Overdue is read from the heartbeat, so a container that restarts twice in
 *    a minute does not re-run an hourly audit twice. Nothing is owed if the
 *    last success is inside the interval.
 *  - A job with a failure streak is left to the normal interval. Gating on
 *    *success* is deliberate — a job killed mid-run by the host suspending is
 *    the case this exists to fix, and it never records one — but that same
 *    property would let a persistently failing job retry on every boot of a
 *    crash loop, hammering whatever external service it failed against.
 */
function scheduleCatchUp(name: string, intervalMs: number, tick: () => Promise<void>): void {
  const delay = CATCH_UP_DELAY_MS + catchUpSlot * CATCH_UP_STAGGER_MS;
  catchUpSlot += 1;

  const timer = setTimeout(async () => {
    try {
      const beat = await prisma.jobHeartbeat.findUnique({
        where: { name },
        select: { lastSucceededAt: true, consecutiveFailures: true },
      });

      if (beat && beat.consecutiveFailures >= CATCH_UP_FAILURE_LIMIT) {
        console.warn(
          `[scheduler] ${name} skipped its catch-up run — ` +
          `${beat.consecutiveFailures} consecutive failures, leaving it to the interval`
        );
        return;
      }

      // Never succeeded, or not since one whole interval ago: work is owed.
      const lastSuccess = beat?.lastSucceededAt?.getTime() ?? 0;
      if (Date.now() - lastSuccess < intervalMs) return;

      console.log(`[scheduler] ${name} running a catch-up sweep (overdue since boot)`);
      await tick();
    } catch (error) {
      // The heartbeat read failing must not take the boot down with it. The
      // normal interval still applies; only the catch-up is lost.
      console.error(`[scheduler] ${name} catch-up failed:`, error);
    }
  }, delay);

  timer.unref();
  timers.push(timer);
}

export function startScheduler(): void {
  if (!env.ENABLE_SCHEDULER) {
    console.log('[scheduler] disabled (ENABLE_SCHEDULER=false)');
    return;
  }

  // Each start lays out its own stagger, so a stop/start inside one process
  // does not push the first catch-up further and further out.
  catchUpSlot = 0;

  schedule('settlement', env.SETTLEMENT_SWEEP_INTERVAL_MS, async () => {
    const result = await runSettlementSweep();
    if (result && result.entriesSettled > 0) {
      console.log(
        `[scheduler] settled ${result.entriesSettled} entries ` +
        `(₹${(result.amountSettled / 100).toFixed(2)}) across ${result.shopsSettled} shop(s)`
      );
    }
  });

  schedule('reconciliation', env.RECONCILE_INTERVAL_MS, async () => {
    const result = await reconcilePayments(15);
    if (result && (result.reconciled > 0 || result.retriedWebhooks > 0)) {
      console.log(
        `[scheduler] reconciliation: checked ${result.checked}, ` +
        `recovered ${result.reconciled}, retried ${result.retriedWebhooks} webhook(s)`
      );
    }
  });

  // Asks Razorpay what it was paid and checks we have an order for each. The
  // reconciliation job above cannot do this: it starts from our own orders, so
  // an order that is missing entirely is invisible to it.
  //
  // This is the job that would have caught the ₹5 order lost on 2026-08-03,
  // when a database restore rolled production back past a payment that had
  // already been captured, printed and completed. Nothing internal noticed —
  // the ledger still balanced, because the earning was removed along with the
  // order it belonged to.
  schedule('payment-audit', env.PAYMENT_AUDIT_INTERVAL_MS, async () => {
    const result = await auditCapturedPayments();
    if (!result) return;

    // The audit reached its page cap, so the window holds payments this pass
    // never looked at — and Razorpay returns newest first, so the ones dropped
    // are the oldest, which are exactly the ones ripe to be judged. An empty
    // `orphans` here does not mean "nothing is wrong"; it means "nothing is
    // wrong in the part we could see", and that distinction is the whole value
    // of this job.
    if (result.truncated) {
      console.error(
        `[scheduler] payment-audit only covered part of its window — the page cap was reached. ` +
        `Older captured payments in this window were not checked.`
      );
      notify.notifyAdmins(
        `The captured-payment audit hit its page limit and could not check its whole window. ` +
        `Payments older than the ${result.checked} it did check are unaudited. Narrow ` +
        `PAYMENT_AUDIT_INTERVAL_MS, or raise the page cap.`,
        'warning'
      );
    }

    if (result.orphans.length === 0) return;

    const total = result.orphans.reduce((sum, o) => sum + o.amountPaise, 0);
    // Logged in full because the alert has to be actionable without a database
    // to hand — by definition the rows it is about are not in the database.
    console.error(
      `[scheduler] payment-audit: ${result.orphans.length} captured payment(s) ` +
      `worth ₹${(total / 100).toFixed(2)} have no order:`,
      result.orphans
    );
    notify.notifyAdmins(
      `${result.orphans.length} captured payment(s) worth ₹${(total / 100).toFixed(2)} ` +
      `have no matching order. Payment ids: ${result.orphans.map((o) => o.paymentId).join(', ')}`,
      'error'
    );
  });

  // The pull side of the refund lifecycle, and the only side that has ever
  // worked: `refund.processed` and `refund.failed` are ticked by hand in the
  // Razorpay dashboard, separately per mode, and `webhook_events` holds zero
  // rows for either despite completed refunds. A refund that nobody confirms
  // stays PROCESSING_REFUND forever — the student is told it is on its way and
  // never told it arrived, the shop is never debited, and the files stay
  // pinned by the unsettled refund.
  //
  // A stranded request is worse than a slow one and is called out separately:
  // the gateway has no refund at all for it, so no amount of waiting resolves
  // it and the student's money is still sitting with us.
  schedule('refund-reconcile', env.REFUND_RECONCILE_INTERVAL_MS, async () => {
    const result = await reconcileStuckRefunds({ stuckMinutes: env.REFUND_STUCK_MINUTES });
    if (!result) return;

    if (result.confirmed > 0 || result.failed > 0) {
      console.log(
        `[scheduler] refund-reconcile: checked ${result.checked}, ` +
        `confirmed ${result.confirmed}, failed ${result.failed}, ` +
        `still pending ${result.stillPending}`
      );
    }

    if (result.stranded.length > 0) {
      console.error(
        `[scheduler] refund-reconcile: ${result.stranded.length} request(s) are refunding ` +
        `with no refund at the gateway:`,
        result.stranded
      );
      notify.notifyAdmins(
        `${result.stranded.length} refund request(s) say they are processing but Razorpay ` +
        `has no refund for them — the money never left. Request ids: ${result.stranded.join(', ')}`,
        'error'
      );
    }
  });

  // Frequent and cheap: the immediate publish on the request path handles the
  // common case, so this mostly finds nothing and exists to recover events
  // whose process died between commit and publish.
  schedule('outbox', env.OUTBOX_DISPATCH_INTERVAL_MS, async () => {
    await dispatchOutbox();
  });

  schedule('outbox-prune', 6 * 60 * 60 * 1000, async () => {
    await pruneOutbox();
  });

  // Orders uploaded and never paid for. Both the inline purge and the retention
  // sweep are gated on a terminal status, so these keep their documents
  // indefinitely — and they are the largest population that never reaches one.
  // Cancelling them hands the files to the machinery that already exists.
  schedule('expire-unpaid', env.UNPAID_ORDER_EXPIRY_INTERVAL_MS, async () => {
    const result = await expireStaleUnpaidOrders();
    if (result && (result.cancelled > 0 || result.stillPaid > 0 || result.skipped > 0)) {
      console.log(
        `[scheduler] expire-unpaid cancelled ${result.cancelled} of ${result.examined} ` +
        `(${result.stillPaid} turned out paid, ${result.skipped} left for the next run)`
      );
    }
  });

  // Backstop for the inline deletion that runs when an order finishes or a
  // ticket is resolved. That call can fail when R2 is briefly unreachable, and
  // orders completed before retention existed have nothing to trigger their
  // removal at all. Without this the bucket keeps documents the rest of the
  // system considers gone.
  schedule('file-retention', env.FILE_RETENTION_SWEEP_INTERVAL_MS, async () => {
    const result = await sweepUndeletedFiles();
    if (result && result.filesRemoved > 0) {
      console.log(
        `[scheduler] file-retention removed ${result.filesRemoved} file(s) ` +
        `from ${result.ordersPurged} order(s) and ${result.ticketsPurged} ticket(s)`
      );
    }
  });

  // Referral codes that expired without ever being redeemed are dead weight:
  // nobody can use them and they attach to no shop. Redeemed codes are never
  // touched — those are the record of how a shop owner got in.
  schedule('referral-sweep', env.REFERRAL_SWEEP_INTERVAL_MS, async () => {
    const deleted = await sweepExpiredReferralCodes();
    if (deleted) {
      console.log(`[scheduler] referral-sweep removed ${deleted} expired unused code(s)`);
    }
  });

  /**
   * The tables nothing else swept.
   *
   * `cleanupExpiredTokens` has existed since the start, correct and unreachable
   * — its own comment said *"called by a cron job in Phase 6"* and nothing ever
   * called it. Rotation writes a row on every refresh and access tokens last
   * fifteen minutes, so one continuously-active session produced around ninety-six
   * rows a day and the table only ever grew. `admin_otps` and `notifications`
   * had no sweep at all.
   *
   * One job rather than three, so the list of tables with a retention policy is
   * in one place and a table missing from it reads as an omission rather than
   * as an absence.
   */
  schedule('retention', env.RETENTION_SWEEP_INTERVAL_MS, async () => {
    const [tokens, otps, notifications, passCheckouts] = await Promise.all([
      cleanupExpiredTokens(),
      sweepExpiredOtps(),
      sweepReadNotifications(),
      // Marks expired pass checkouts abandoned rather than deleting them — a
      // late capture must still find the purchase it belongs to.
      abandonExpiredPassCheckouts(),
    ]);

    if (tokens > 0 || otps > 0 || notifications > 0 || passCheckouts > 0) {
      console.log(
        `[scheduler] retention removed ${tokens} expired/revoked refresh token(s), ` +
        `${otps} spent verification code(s) and ${notifications} read notification(s); ` +
        `abandoned ${passCheckouts} unpaid pass checkout(s)`
      );
    }
  });

  // Keeps system_events and remediation_log inside their retention window.
  // Only resolved events are deleted — an unresolved defect that stopped
  // recurring is precisely what you want still on screen when it returns.
  schedule('event-sweep', 24 * 60 * 60 * 1000, async () => {
    const result = await sweepOldEvents();
    if (result && (result.events > 0 || result.remediations > 0)) {
      console.log(
        `[scheduler] event-sweep removed ${result.events} resolved event(s) ` +
        `and ${result.remediations} remediation record(s)`
      );
    }
  });

  console.log(
    `[scheduler] started — settlement ${env.SETTLEMENT_SWEEP_INTERVAL_MS}ms, ` +
    `reconciliation ${env.RECONCILE_INTERVAL_MS}ms, outbox ${env.OUTBOX_DISPATCH_INTERVAL_MS}ms`
  );
}

/**
 * Stop every timer this module started.
 *
 * `clearTimeout` and `clearInterval` are interchangeable in Node — both take a
 * Timeout object and both work — so this was never a live bug. It is written
 * out properly anyway because the array holds both kinds (`schedule` pushes an
 * interval, `scheduleCatchUp` pushes a timeout) and relying on the two being
 * the same function is relying on an implementation detail rather than a
 * documented contract.
 */
export function stopScheduler(): void {
  while (timers.length) {
    const timer = timers.pop();
    if (!timer) continue;
    clearInterval(timer);
    clearTimeout(timer);
  }
}
