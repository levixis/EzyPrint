import type { SystemEventSeverity } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { env } from '../config/env';
import { sendNoticeEmail } from './email.service';
import { sendPushToUser } from './push.service';
import { markAlerted, type CapturedEvent } from './observability.service';
import type { HealthReport } from './health.service';

/**
 * Alert routing — the part that wakes a person up.
 *
 * Three channels, chosen because they fail independently:
 *
 *   • Email to ALERT_EMAIL — the durable one, and the one that carries enough
 *     text to diagnose from. Useless when the broken thing is mail delivery.
 *   • FCM push to every admin account — instant, and it still works when the
 *     mail provider is the outage. Carries a headline, not a diagnosis.
 *   • An in-app Notification row for admins — the record that survives both,
 *     and what the dashboard reads back.
 *
 * All three are attempted independently and none can fail the others. A partial
 * delivery is a far better outcome than an exception thrown inside the code
 * whose job is to report exceptions.
 *
 * ── Why the rate limiting is not optional ──
 *
 * The failure mode of alerting is not silence, it is volume. One broken
 * endpoint hit by a class of 300 students, on a two-minute watchdog cycle, is
 * hundreds of identical messages. An operator mutes that channel within the
 * hour and then believes they have monitoring they no longer have — strictly
 * worse than never having built it. So: a per-fingerprint cooldown, and a hard
 * hourly ceiling across everything.
 */

export interface AlertParams {
  severity: SystemEventSeverity;
  title: string;
  body: string;
  /** Dedupe key. Alerts sharing one are subject to the same cooldown. */
  fingerprint: string;
}

/**
 * Hourly send counter.
 *
 * In memory on purpose. Its only job is to stop a runaway loop inside one
 * process lifetime, and a restart clearing it is the correct behaviour — a
 * fresh process after a crash *should* be allowed to tell you about the crash.
 * The durable, restart-surviving limit is the per-fingerprint cooldown, which
 * lives in `system_events.lastAlertedAt`.
 */
let windowStartedAt = Date.now();
let sentThisWindow = 0;

function withinHourlyBudget(): boolean {
  const now = Date.now();
  if (now - windowStartedAt > 60 * 60 * 1000) {
    windowStartedAt = now;
    sentThisWindow = 0;
  }
  return sentThisWindow < env.ALERT_MAX_PER_HOUR;
}

/** Admin user ids, for push and in-app delivery. */
async function adminUserIds(): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { type: 'ADMIN' },
    select: { id: true },
  });
  return admins.map((admin) => admin.id);
}

const SEVERITY_PREFIX: Record<SystemEventSeverity, string> = {
  INFO: 'ℹ️',
  WARNING: '⚠️',
  ERROR: '🔴',
  CRITICAL: '🚨',
};

/**
 * Deliver on every channel. Bypasses deduplication — callers that should
 * respect the cooldown use `maybeSend`.
 */
export async function send(params: AlertParams): Promise<void> {
  const { severity, title, body } = params;
  const prefix = SEVERITY_PREFIX[severity];

  if (!withinHourlyBudget()) {
    console.warn(`[alert] hourly budget exhausted — suppressed: ${title}`);
    return;
  }
  sentThisWindow++;

  console.log(`[alert] ${prefix} ${title}`);

  // Independent, so one dead channel cannot take the others with it.
  await Promise.allSettled([
    deliverEmail(severity, title, body),
    deliverPush(severity, title),
    deliverInApp(severity, title),
  ]);
}

async function deliverEmail(severity: SystemEventSeverity, title: string, body: string): Promise<void> {
  if (!env.ALERT_EMAIL) return;

  try {
    await sendNoticeEmail({
      to: env.ALERT_EMAIL,
      subject: `${SEVERITY_PREFIX[severity]} EzyPrint ${severity}: ${title}`,
      heading: title,
      lines: [
        body,
        '',
        `Environment: ${env.NODE_ENV}`,
        `Time: ${new Date().toISOString()}`,
        '',
        'Open the admin dashboard → System Health for the full report.',
      ],
      tone: severity === 'INFO' ? 'good' : 'bad',
    });
  } catch (error) {
    console.error('[alert] email delivery failed:', error);
  }
}

async function deliverPush(severity: SystemEventSeverity, title: string): Promise<void> {
  // Push carries the headline only. The body of an operational alert is a
  // stack trace and a set of counters, which is not what a lock screen is for.
  if (severity === 'INFO') return;

  try {
    const admins = await adminUserIds();
    await Promise.allSettled(
      admins.map((userId) =>
        sendPushToUser(userId, {
          title: `${SEVERITY_PREFIX[severity]} EzyPrint ${severity}`,
          body: title.slice(0, 140),
          channel: 'ezyprint_account',
          data: { kind: 'system_alert' },
        })
      )
    );
  } catch (error) {
    console.error('[alert] push delivery failed:', error);
  }
}

async function deliverInApp(severity: SystemEventSeverity, title: string): Promise<void> {
  try {
    const admins = await adminUserIds();
    if (admins.length === 0) return;

    // The Notification model carries a single `message` — no separate title —
    // so the headline is folded in rather than dropped. The bell is a pointer
    // to the dashboard here, not the place the incident gets read.
    await prisma.notification.createMany({
      data: admins.map((recipientUserId) => ({
        recipientUserId,
        message: `System: ${title}`.slice(0, 500),
        type:
          severity === 'INFO'
            ? ('info' as const)
            : severity === 'WARNING'
              ? ('warning' as const)
              : ('error' as const),
      })),
    });
  } catch (error) {
    console.error('[alert] in-app delivery failed:', error);
  }
}

/**
 * Send only if this fingerprint has not been alerted about recently.
 *
 * The cooldown is read from the event row rather than from memory so it holds
 * across the restarts and sleeps this host does constantly — the exact
 * condition under which an in-process timer would re-send the same alert on
 * every wake.
 *
 * A brand-new event always goes out immediately regardless of cooldown: the
 * first occurrence of a defect is the one worth interrupting someone for.
 */
/**
 * How long to stay quiet about a fault, growing with how long it has been open.
 *
 * A fixed cooldown is wrong for a condition nobody has fixed yet. At 15 minutes
 * flat, a background job that stops overnight sends about 60 emails, and the
 * 60th says exactly what the first did. The information is all in the first
 * one; the rest only train you to ignore the sender.
 *
 * So the interval widens the longer the fault persists. A fresh problem still
 * interrupts you promptly; one you have already been told about four times
 * settles into a reminder every six hours until it clears — and the all-clear
 * still arrives the moment it does.
 */
function cooldownFor(event: CapturedEvent): number {
  const openForMs = Date.now() - event.firstSeenAt.getTime();

  if (openForMs < 60 * 60 * 1000) return env.ALERT_COOLDOWN_MS;        // first hour: 15 min
  if (openForMs < 6 * 60 * 60 * 1000) return 60 * 60 * 1000;           // first 6h: hourly
  return 6 * 60 * 60 * 1000;                                           // beyond: 6-hourly
}

export async function maybeSend(
  event: CapturedEvent,
  message: { title: string; body: string }
): Promise<boolean> {
  const cooledDown =
    !event.lastAlertedAt || Date.now() - event.lastAlertedAt.getTime() > cooldownFor(event);

  if (!event.isNew && !cooledDown) return false;

  const occurrences = event.count > 1 ? `\n\nSeen ${event.count} times.` : '';

  await send({
    severity: event.severity,
    title: message.title,
    body: message.body + occurrences,
    fingerprint: event.fingerprint,
  });

  await markAlerted(event.fingerprint);
  return true;
}

/**
 * Tell the operator that everything the watchdog was alerting about has cleared.
 *
 * Only fires when there was something to clear, tracked in memory: an
 * all-clear on every quiet cycle would be a message every two minutes, which
 * is the noise problem this file exists to avoid. Losing this flag on restart
 * costs at most one missing all-clear — the health endpoint still shows green.
 */
let hadFailures = false;

export async function clearActive(report: HealthReport): Promise<void> {
  if (!hadFailures) return;
  hadFailures = false;

  await send({
    severity: 'INFO',
    title: 'All systems recovered',
    body:
      `Every health check is passing again as of ${report.checkedAt}.\n\n` +
      report.checks.map((check) => `  ✓ ${check.name}: ${check.summary}`).join('\n'),
    fingerprint: 'watchdog-all-clear',
  });
}

/** Called by the watchdog when a check fails, so `clearActive` knows to speak. */
export function noteFailure(): void {
  hadFailures = true;
}

export const __testing = {
  resetBudget: () => {
    windowStartedAt = Date.now();
    sentThisWindow = 0;
  },
  budgetUsed: () => sentThisWindow,
};
