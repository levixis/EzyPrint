import { prisma } from '../utils/prisma';
import { env } from '../config/env';
import { runSettlementSweep } from './settlement.service';
import { reconcilePayments } from './payment.service';
import { dispatchOutbox, pruneOutbox } from './realtime.service';
import { sweepUndeletedFiles } from './cleanup.service';
import { sweepExpiredReferralCodes } from './referral.service';

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
    try {
      await job();
    } catch (error) {
      // A failing job must never take the process down; the next tick retries.
      console.error(`[scheduler] ${name} failed:`, error);
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
