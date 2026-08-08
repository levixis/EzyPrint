import { prisma } from '../utils/prisma';
import { env } from '../config/env';
import { probeStorage } from './storage.service';
import { probeGateway } from './payment.service';

/**
 * Deep health checks — the diagnostic layer the watchdog and the dashboard
 * both read from.
 *
 * `/health` already answered "is the process up and can it reach Postgres".
 * That question was never the one that mattered here: every real incident in
 * this app's history passed it. The webhook returning 400 for months, the
 * scheduler not running because the instance was asleep, uploads going to a
 * disk that gets wiped, mail being sent to a provider that drops it — the
 * server was up and the database was connected through all of them.
 *
 * So these checks are written against the specific ways this system has
 * actually failed, not against a generic template. Each one names the
 * consequence in plain terms, because the point of the check is to be
 * understood at 2am by the one person who runs this.
 *
 * ── Cost discipline ──
 *
 * This runs every WATCHDOG_INTERVAL_MS and on every dashboard load. Neon bills
 * compute, so the queries here are counts against indexed columns, never scans
 * of orders or ledger entries. The two external probes (R2, Razorpay) are the
 * expensive part and are skipped on the fast path — see `runHealthChecks`.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface HealthCheck {
  /** Stable id — the watchdog maps these to remediations. */
  name: string;
  status: CheckStatus;
  /** One line, written for a human who was asleep 30 seconds ago. */
  summary: string;
  /** Numbers behind the verdict, for the dashboard. */
  detail?: Record<string, unknown>;
  latencyMs?: number;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  checkedAt: string;
  uptimeSeconds: number;
  environment: string;
  checks: HealthCheck[];
}

/** Run a check, converting a throw into a `fail` rather than losing the report. */
async function timed(
  name: string,
  run: () => Promise<Omit<HealthCheck, 'name' | 'latencyMs'>>
): Promise<HealthCheck> {
  const started = Date.now();
  try {
    const result = await run();
    return { name, ...result, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      name,
      status: 'fail',
      summary: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// INDIVIDUAL CHECKS
// ─────────────────────────────────────────────────────────────

async function checkDatabase(): Promise<HealthCheck> {
  return timed('database', async () => {
    const started = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const latency = Date.now() - started;

    // Neon's free tier suspends after inactivity and the first query pays the
    // wake. Slow is worth reporting; it is not worth paging over.
    if (latency > 3000) {
      return {
        status: 'warn' as const,
        summary: `Database responded in ${latency}ms — likely a cold Neon start.`,
        detail: { latencyMs: latency },
      };
    }
    return { status: 'ok' as const, summary: 'Connected.', detail: { latencyMs: latency } };
  });
}

/**
 * Are the background jobs actually running?
 *
 * The single highest-value check in this file. On Render's free tier a sleeping
 * instance runs no scheduler, and every consequence is silent and financial:
 * shop earnings never mature from clearing to available, captured payments that
 * missed their webhook are never recovered, deleted orders keep their files.
 * Nobody complains, because nothing errors.
 */
async function checkScheduler(): Promise<HealthCheck> {
  return timed('scheduler', async () => {
    if (!env.ENABLE_SCHEDULER) {
      return { status: 'skipped' as const, summary: 'Scheduler disabled by configuration.' };
    }

    const heartbeats = await prisma.jobHeartbeat.findMany();

    if (heartbeats.length === 0) {
      return {
        status: 'warn' as const,
        summary: 'No job has reported yet — normal for the first few minutes after a deploy.',
      };
    }

    // Each job is judged against its own interval: outbox runs every 10s, the
    // referral sweep every 24h, and one threshold cannot serve both.
    const intervals: Record<string, number> = {
      settlement: env.SETTLEMENT_SWEEP_INTERVAL_MS,
      reconciliation: env.RECONCILE_INTERVAL_MS,
      'payment-audit': env.PAYMENT_AUDIT_INTERVAL_MS,
      'refund-reconcile': env.REFUND_RECONCILE_INTERVAL_MS,
      outbox: env.OUTBOX_DISPATCH_INTERVAL_MS,
      'file-retention': env.FILE_RETENTION_SWEEP_INTERVAL_MS,
      'referral-sweep': env.REFERRAL_SWEEP_INTERVAL_MS,
      'event-sweep': env.SYSTEM_EVENT_RETENTION_DAYS > 0 ? 24 * 60 * 60 * 1000 : 0,
    };

    const now = Date.now();
    const stalled: string[] = [];
    const failing: string[] = [];

    for (const beat of heartbeats) {
      const interval = intervals[beat.name];
      if (!interval) continue;

      const deadline = interval * env.WATCHDOG_STALL_MULTIPLIER;
      const last = beat.lastSucceededAt?.getTime() ?? 0;

      if (now - last > deadline) {
        stalled.push(
          `${beat.name} (last success ${last ? `${Math.round((now - last) / 60000)}m ago` : 'never'})`
        );
      }
      if (beat.consecutiveFailures >= 3) {
        failing.push(`${beat.name} × ${beat.consecutiveFailures}: ${beat.lastError ?? 'unknown'}`);
      }
    }

    if (failing.length > 0) {
      return {
        status: 'fail' as const,
        summary: `Background jobs erroring repeatedly: ${failing.join('; ')}`,
        detail: { failing, stalled },
      };
    }
    if (stalled.length > 0) {
      return {
        status: 'fail' as const,
        summary:
          `Background jobs have stopped running: ${stalled.join(', ')}. ` +
          `Shop earnings will not mature and dropped payments will not be recovered.`,
        detail: { stalled },
      };
    }

    return {
      status: 'ok' as const,
      summary: `All ${heartbeats.length} background jobs reporting.`,
      detail: { jobs: heartbeats.length },
    };
  });
}

/**
 * Paid orders that never advanced past PENDING_PAYMENT.
 *
 * The student has been charged and has no order. This is the failure that
 * matters more than any other in the system, and it is invisible from the
 * outside: the payment succeeded, the app moved on, and only the gateway and
 * this query know.
 *
 * The grace window exists because the gap between "Razorpay captured" and "our
 * webhook landed" is legitimately seconds. Anything still stranded after 20
 * minutes is not in flight, it is lost.
 */
async function checkStrandedPayments(): Promise<HealthCheck> {
  return timed('stranded_payments', async () => {
    const cutoff = new Date(Date.now() - 20 * 60 * 1000);

    // Deliberately the same predicate `reconcilePayments` sweeps on, including
    // PAYMENT_FAILED. That status is written by the client the moment the
    // checkout sheet closes, which is a guess — a student who dismissed the
    // sheet and then approved the UPI collect in their bank app is recorded
    // failed here and captured at Razorpay. Checking a narrower set than the
    // fix repairs would mean the watchdog never triggers on the cases that
    // most need it.
    const stranded = await prisma.order.count({
      where: {
        status: { in: ['PENDING_PAYMENT', 'PAYMENT_FAILED'] },
        razorpayOrderId: { not: null },
        paymentAttemptedAt: { lt: cutoff },
      },
    });

    if (stranded > 0) {
      return {
        status: 'fail' as const,
        summary:
          `${stranded} order(s) have a payment attempt but never advanced. ` +
          `If those payments captured, students paid and have nothing.`,
        detail: { stranded },
      };
    }
    return { status: 'ok' as const, summary: 'No stranded payments.', detail: { stranded: 0 } };
  });
}

/**
 * Refunds that were started and never finished.
 *
 * A refund stays PROCESSING_REFUND until Razorpay confirms it, which arrives
 * either on the `refund.processed` webhook or from the `refund-reconcile` poll
 * that exists because that webhook has never delivered an event here. If both
 * are broken nothing errors: the student keeps seeing "Refund Initiated"
 * indefinitely, the shop is never debited, and the order's files stay pinned by
 * `UNSETTLED_REFUND_STATUSES`.
 *
 * The threshold is generous because Razorpay is entitled to take days. This is
 * not asking whether a refund is slow — the poll handles slow. It is asking
 * whether the thing that *ends* refunds is working at all, and a day of no
 * refund reaching a terminal state answers that.
 */
async function checkStrandedRefunds(): Promise<HealthCheck> {
  return timed('stranded_refunds', async () => {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const stuck = await prisma.refundRequest.count({
      where: {
        status: 'PROCESSING_REFUND',
        OR: [
          { adminResolvedAt: { lt: cutoff } },
          { adminResolvedAt: null, studentRequestedAt: { lt: cutoff } },
        ],
      },
    });

    if (stuck > 0) {
      return {
        status: 'fail' as const,
        summary:
          `${stuck} refund(s) have been processing for over a day. Students were told ` +
          `their money was on its way and have not been told it arrived. Check that ` +
          `refund.processed and refund.failed are ticked on the live Razorpay webhook.`,
        detail: { stuck },
      };
    }
    return { status: 'ok' as const, summary: 'No refunds stuck in flight.', detail: { stuck: 0 } };
  });
}

/**
 * Real-time events written but never delivered.
 *
 * A backlog means shop dashboards are showing stale balances. Not an emergency
 * — the numbers are correct in the database and a refetch fixes the screen —
 * but a growing backlog is the earliest visible symptom of the dispatcher
 * having died, which is worth catching before the rest follows.
 */
async function checkOutbox(): Promise<HealthCheck> {
  return timed('realtime_outbox', async () => {
    const pending = await prisma.realtimeOutbox.count({ where: { publishedAt: null } });

    if (pending === 0) {
      return { status: 'ok' as const, summary: 'No undelivered events.', detail: { pending: 0 } };
    }

    const oldest = await prisma.realtimeOutbox.findFirst({
      where: { publishedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, attempts: true, lastError: true },
    });

    const ageMinutes = oldest ? Math.round((Date.now() - oldest.createdAt.getTime()) / 60000) : 0;

    // Under a few minutes with a small queue is the dispatcher working, caught
    // mid-cycle. The 10s interval means anything older than ~5 minutes is stuck.
    if (ageMinutes > 5) {
      return {
        status: 'fail' as const,
        summary:
          `${pending} real-time event(s) undelivered, oldest ${ageMinutes}m. ` +
          `Shop dashboards are showing stale balances.`,
        detail: { pending, oldestAgeMinutes: ageMinutes, attempts: oldest?.attempts, lastError: oldest?.lastError },
      };
    }

    return {
      status: 'ok' as const,
      summary: `${pending} event(s) in flight.`,
      detail: { pending, oldestAgeMinutes: ageMinutes },
    };
  });
}

/**
 * Earnings that matured but were never swept into `available`.
 *
 * The settlement sweep is what moves money from clearing to withdrawable. If it
 * stops, shops see money they cannot withdraw and payout requests fail the
 * ledger's own balance check — which reads to the shop owner as the platform
 * refusing to pay them.
 */
async function checkSettlementBacklog(): Promise<HealthCheck> {
  return timed('settlement_backlog', async () => {
    // "Clearing" is a UI word, not a stored status: an earning in that stage is
    // PENDING with an `availableAt` in the future. Once that time passes and
    // the row is still PENDING, the sweep that should have settled it did not
    // run. This is the exact predicate runSettlementSweep selects on.
    const overdue = await prisma.ledgerEntry.count({
      where: {
        type: 'ORDER_EARNING',
        status: 'PENDING',
        availableAt: { not: null, lte: new Date() },
      },
    });

    if (overdue > 0) {
      return {
        status: 'fail' as const,
        summary:
          `${overdue} earning(s) passed their release time and are still clearing. ` +
          `Shops cannot withdraw money they have earned.`,
        detail: { overdue },
      };
    }
    return { status: 'ok' as const, summary: 'No overdue settlements.', detail: { overdue: 0 } };
  });
}

/**
 * Webhook deliveries we accepted but failed to process.
 *
 * Distinct from stranded payments: this is our own processing erroring after
 * a delivery arrived, so the row exists and names the reason.
 */
async function checkWebhookProcessing(): Promise<HealthCheck> {
  return timed('webhooks', async () => {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [unprocessed, recent] = await Promise.all([
      prisma.webhookEvent.count({ where: { processed: false, createdAt: { lt: new Date(Date.now() - 10 * 60 * 1000) } } }),
      prisma.webhookEvent.count({ where: { createdAt: { gte: cutoff } } }),
    ]);

    if (unprocessed > 0) {
      const sample = await prisma.webhookEvent.findFirst({
        where: { processed: false },
        orderBy: { createdAt: 'asc' },
        select: { eventType: true, processingError: true },
      });
      return {
        status: 'fail' as const,
        summary: `${unprocessed} webhook(s) accepted but not processed. Latest reason: ${sample?.processingError ?? 'none recorded'}`,
        detail: { unprocessed, receivedLast24h: recent, sampleType: sample?.eventType },
      };
    }

    return {
      status: 'ok' as const,
      summary: `${recent} webhook(s) processed in the last 24h.`,
      detail: { unprocessed: 0, receivedLast24h: recent },
    };
  });
}

/**
 * Can we actually send mail?
 *
 * Configuration only — no test send. Sending real mail on every health check
 * burns the provider's quota and, on a domain whose reputation is new, teaches
 * inbox providers that this sender emits traffic nobody asked for.
 *
 * That limits this to catching the misconfiguration that has already bitten:
 * a From address on resend.dev, which delivers to exactly one mailbox while
 * reporting success for every other recipient.
 */
async function checkEmail(): Promise<HealthCheck> {
  return timed('email', async () => {
    const hasTransport = Boolean(env.RESEND_API_KEY || env.GMAIL_APP_PASSWORD);

    if (!hasTransport) {
      return {
        status: 'fail' as const,
        summary:
          'No mail transport configured. Password resets, payout OTPs and account ' +
          'deletion codes are all silently failing.',
      };
    }

    if (/resend\.dev/i.test(env.EMAIL_FROM)) {
      return {
        status: 'fail' as const,
        summary:
          `EMAIL_FROM is on resend.dev — mail reaches only the Resend account owner. ` +
          `Every other recipient gets nothing, with no error.`,
        detail: { from: env.EMAIL_FROM },
      };
    }

    return {
      status: 'ok' as const,
      summary: `Configured (${env.RESEND_API_KEY ? 'Resend HTTP' : 'SMTP'}).`,
      detail: { from: env.EMAIL_FROM, transport: env.RESEND_API_KEY ? 'resend' : 'smtp' },
    };
  });
}

/**
 * Unresolved defects the error recorder has collected.
 *
 * Counts application errors only — `source: 'health'` is excluded, and that
 * exclusion is the whole correctness of this check rather than a refinement.
 *
 * Every failing health check is escalated by the watchdog as a CRITICAL
 * `system_events` row with `source: 'health'`. Counting those means counting
 * this check's own alert: one failure writes the `health:errors` row, that row
 * is an unresolved CRITICAL, so the next cycle fails again on the evidence it
 * just created. Observed doing exactly that — 8 unresolved criticals, all of
 * them `source: 'health'`, none an actual application error, with the row's own
 * message reading "8 unresolved critical error(s)".
 *
 * The consequences are not cosmetic. The check could never return to `ok` once
 * any check had failed once, so `status` was permanently `degraded`, the
 * all-clear in `alert.clearActive` could never fire, and the alert re-sent on
 * its escalating backoff forever. A monitor that is always red is one you stop
 * reading — which is the failure this whole subsystem exists to avoid.
 *
 * Nothing is lost by excluding them: every one of those rows is a *derived*
 * signal from a check that already reports itself in this same report. What
 * belongs here is what nothing else reports — unhandled request errors, crashed
 * processes, failing jobs.
 */
const DERIVED_SOURCE = 'health';

async function checkErrorRate(): Promise<HealthCheck> {
  return timed('errors', async () => {
    const lastHour = new Date(Date.now() - 60 * 60 * 1000);

    const [critical, recent] = await Promise.all([
      prisma.systemEvent.count({
        where: { resolvedAt: null, severity: 'CRITICAL', source: { not: DERIVED_SOURCE } },
      }),
      prisma.systemEvent.count({
        where: { resolvedAt: null, lastSeenAt: { gte: lastHour }, source: { not: DERIVED_SOURCE } },
      }),
    ]);

    if (critical > 0) {
      return {
        status: 'fail' as const,
        summary: `${critical} unresolved critical error(s).`,
        detail: { critical, activeLastHour: recent },
      };
    }
    if (recent > 0) {
      return {
        status: 'warn' as const,
        summary: `${recent} distinct error(s) seen in the last hour.`,
        detail: { critical: 0, activeLastHour: recent },
      };
    }
    return { status: 'ok' as const, summary: 'No errors in the last hour.', detail: { critical: 0, activeLastHour: 0 } };
  });
}

async function checkStorage(): Promise<HealthCheck> {
  return timed('storage', async () => {
    const result = await probeStorage();
    if (result.mode === 'local' && env.isProd) {
      return {
        status: 'fail' as const,
        summary: 'Storage is in local mode in production — uploads are lost on every redeploy.',
        detail: result,
      };
    }
    return { status: 'ok' as const, summary: result.detail, detail: result };
  });
}

async function checkPaymentGateway(): Promise<HealthCheck> {
  return timed('payment_gateway', async () => {
    const result = await probeGateway();
    if (result.mode === 'test' && env.isProd) {
      return {
        status: 'fail' as const,
        summary: 'Razorpay is on TEST keys in production — no real payment can be collected.',
        detail: result,
      };
    }
    return { status: 'ok' as const, summary: result.detail, detail: result };
  });
}

// ─────────────────────────────────────────────────────────────
// REPORT
// ─────────────────────────────────────────────────────────────

/**
 * Internal checks only — every one is a database query against an index.
 *
 * Split from the external probes because this set runs on the watchdog's
 * interval and on every dashboard poll, where a 2-second round trip to
 * Cloudflare and Razorpay on each call is both slow and rude.
 */
const FAST_CHECKS = [
  checkDatabase,
  checkScheduler,
  checkStrandedPayments,
  checkStrandedRefunds,
  checkOutbox,
  checkSettlementBacklog,
  checkWebhookProcessing,
  checkEmail,
  checkErrorRate,
];

/** The two that leave the building. */
const DEEP_CHECKS = [checkStorage, checkPaymentGateway];

export async function runHealthChecks(options: { deep?: boolean } = {}): Promise<HealthReport> {
  const checks = options.deep ? [...FAST_CHECKS, ...DEEP_CHECKS] : FAST_CHECKS;

  // Parallel: they are independent, and serially they would add up to a
  // timeout on the very incident where the report is needed most.
  const results = await Promise.all(checks.map((check) => check()));

  // `down` is reserved for the database being unreachable. Everything else,
  // however bad, is a working server with a broken part — and calling that
  // "down" to an uptime monitor would page for a stale outbox.
  const dbFailed = results.find((r) => r.name === 'database')?.status === 'fail';
  const anyFailed = results.some((r) => r.status === 'fail');

  return {
    status: dbFailed ? 'down' : anyFailed ? 'degraded' : 'ok',
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    environment: env.NODE_ENV,
    checks: results,
  };
}
