import { prisma } from '../utils/prisma';
import { env } from '../config/env';
import { runSettlementSweep } from './settlement.service';
import { reconcilePayments, auditCapturedPayments, reconcileStuckRefunds } from './payment.service';
import * as notify from './notify.service';
import { dispatchOutbox, pruneOutbox } from './realtime.service';
import { sweepUndeletedFiles } from './cleanup.service';
import { sweepExpiredReferralCodes } from './referral.service';
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
 * Every job holds a Postgres advisory lock for its duration. Advisory locks are
 * held on a session and released automatically if the connection dies, so a
 * crashed instance cannot leave a job permanently blocked — unlike a lock row
 * in a table, which would need its own expiry handling. If a second Railway
 * replica is ever started, only one instance runs each job.
 */

/** Distinct lock keys. Arbitrary but must stay stable across deploys. */
const LOCK_KEYS = {
  settlement: 4820_001,
  reconciliation: 4820_002,
  outboxPrune: 4820_003,
  fileRetention: 4820_004,
  referralSweep: 4820_005,
  paymentAudit: 4820_006,
  eventSweep: 4820_007,
  refundReconcile: 4820_008,
} as const;

/**
 * Run `work` only if this instance can take the advisory lock.
 *
 * Returns null when another instance holds it — that is a normal outcome, not
 * an error.
 */
async function withAdvisoryLock<T>(key: number, work: () => Promise<T>): Promise<T | null> {
  const [{ locked }] = await prisma.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(${key}::bigint) AS locked
  `;

  if (!locked) return null;

  try {
    return await work();
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${key}::bigint)`;
  }
}

const timers: NodeJS.Timeout[] = [];

/**
 * Schedule `job` on an interval, guarded so a slow run cannot overlap itself.
 */
function schedule(name: string, intervalMs: number, job: () => Promise<void>): void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    const started = Date.now();

    // Every run writes a heartbeat. This is what makes "the scheduler stopped"
    // detectable at all: the logs record that a job *started*, and only the
    // heartbeat records that it finished. On a host that sleeps, a job that
    // silently stops running is otherwise indistinguishable from one that runs
    // and finds nothing to do — and the consequences (earnings that never
    // mature, payments never recovered) surface days later as a support ticket.
    await recordJobStart(name);

    try {
      await job();
      await recordJobSuccess(name, Date.now() - started);
    } catch (error) {
      // A failing job must never take the process down; the next tick retries.
      console.error(`[scheduler] ${name} failed:`, error);
      await recordJobFailure(name, error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Do not keep the event loop alive purely for a background job.
  timer.unref();
  timers.push(timer);
}

export function startScheduler(): void {
  if (!env.ENABLE_SCHEDULER) {
    console.log('[scheduler] disabled (ENABLE_SCHEDULER=false)');
    return;
  }

  schedule('settlement', env.SETTLEMENT_SWEEP_INTERVAL_MS, async () => {
    const result = await withAdvisoryLock(LOCK_KEYS.settlement, () => runSettlementSweep());
    if (result && result.entriesSettled > 0) {
      console.log(
        `[scheduler] settled ${result.entriesSettled} entries ` +
        `(₹${(result.amountSettled / 100).toFixed(2)}) across ${result.shopsSettled} shop(s)`
      );
    }
  });

  schedule('reconciliation', env.RECONCILE_INTERVAL_MS, async () => {
    const result = await withAdvisoryLock(LOCK_KEYS.reconciliation, () => reconcilePayments(15));
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
    const result = await withAdvisoryLock(LOCK_KEYS.paymentAudit, () => auditCapturedPayments());
    if (!result || result.orphans.length === 0) return;

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
    const result = await withAdvisoryLock(LOCK_KEYS.refundReconcile, () =>
      reconcileStuckRefunds({ stuckMinutes: env.REFUND_STUCK_MINUTES })
    );
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
    await withAdvisoryLock(LOCK_KEYS.outboxPrune, () => pruneOutbox());
  });

  // Backstop for the inline deletion that runs when an order finishes or a
  // ticket is resolved. That call can fail when R2 is briefly unreachable, and
  // orders completed before retention existed have nothing to trigger their
  // removal at all. Without this the bucket keeps documents the rest of the
  // system considers gone.
  schedule('file-retention', env.FILE_RETENTION_SWEEP_INTERVAL_MS, async () => {
    const result = await withAdvisoryLock(LOCK_KEYS.fileRetention, () => sweepUndeletedFiles());
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
    const deleted = await withAdvisoryLock(LOCK_KEYS.referralSweep, () => sweepExpiredReferralCodes());
    if (deleted) {
      console.log(`[scheduler] referral-sweep removed ${deleted} expired unused code(s)`);
    }
  });

  // Keeps system_events and remediation_log inside their retention window.
  // Only resolved events are deleted — an unresolved defect that stopped
  // recurring is precisely what you want still on screen when it returns.
  schedule('event-sweep', 24 * 60 * 60 * 1000, async () => {
    const result = await withAdvisoryLock(LOCK_KEYS.eventSweep, () => sweepOldEvents());
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

export function stopScheduler(): void {
  while (timers.length) {
    const timer = timers.pop();
    if (timer) clearInterval(timer);
  }
}
