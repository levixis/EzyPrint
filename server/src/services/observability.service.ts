import crypto from 'crypto';
import type { SystemEventSeverity } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { env } from '../config/env';

/**
 * Error capture and aggregation.
 *
 * This is the recording half of the monitoring system; `alert.service` is the
 * telling half and `watchdog.service` is the acting half. Keeping them apart
 * matters because they fail differently: recording can fail when the database
 * is down, telling can fail when the mail provider is down, and acting must be
 * able to be switched off without switching off either of the others.
 *
 * ── The one rule ──
 *
 * Nothing in this file may ever throw into its caller. Every export swallows
 * its own failures. Monitoring code that can break the thing it monitors is a
 * net loss: an outage caused by the error reporter is both an outage and a
 * blind one. Callers sit on the request path and in the process-level crash
 * handlers, where there is no one left to catch anything.
 */

/** Values that differ between two occurrences of the same defect. */
const NOISE_PATTERNS: Array<[RegExp, string]> = [
  // cuid / cuid2 — every id in this schema.
  //
  // 20 rather than 24 after the leading `c`: cuid v1 is 25 characters and cuid2
  // is configurable and shorter. Pinning the exact v1 length meant any id that
  // was not exactly 25 characters passed through unnormalized, and one
  // unnormalized id in a message defeats the whole aggregation — every
  // occurrence becomes its own row. No English word is 21+ characters of
  // lowercase alphanumerics, so the looser bound costs nothing.
  [/\bc[a-z0-9]{20,}\b/gi, '<id>'],
  // uuid
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  // Razorpay ids: order_xxx, pay_xxx, rfnd_xxx
  [/\b(order|pay|rfnd|plan|sub)_[A-Za-z0-9]+\b/g, '<rzp_id>'],
  // ISO timestamps
  [/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<ts>'],
  // email addresses
  [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, '<email>'],
  // long hex runs (hashes, tokens)
  [/\b[0-9a-f]{16,}\b/gi, '<hash>'],
  /**
   * Any run of digits — last, so it cannot eat the patterns above.
   *
   * Deliberately NOT `\b\d+\b`. That version required a word boundary on both
   * sides, which does not exist between the digits and the letter in "39m",
   * "5s" or "200ms" — so durations passed through unnormalized. The scheduler
   * check reports "last success 39m ago", which meant every cycle produced a
   * different message, a different fingerprint, and therefore a brand-new
   * event that bypassed the alert cooldown by design. One stuck job sent an
   * email every couple of minutes.
   */
  [/\d+/g, '<n>'],
];

/**
 * Reduce a message to the defect it describes.
 *
 * "Order cm3x9a… could not be repriced: 4 pages" and "Order cm7k2b… could not
 * be repriced: 11 pages" are one bug reported twice. Fingerprinting the raw
 * strings would file them as two, and by the time a class of 300 students has
 * hit it there is no aggregate left to notice — just a wall of singletons.
 */
function normalize(message: string): string {
  return NOISE_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    message
  ).slice(0, 500);
}

function fingerprint(source: string, message: string): string {
  return crypto
    .createHash('sha1')
    .update(`${source}::${normalize(message)}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Keys whose values must never reach this table.
 *
 * system_events is read by the admin dashboard, so anything stored here is
 * effectively displayed. Context is meant to hold the shape of a failure — a
 * route, a job name, a status code — not the payload that triggered it.
 */
const REDACTED_KEYS = /^(password|token|otp|secret|authorization|cookie|refreshToken|accessToken|key|signature)$/i;

function sanitizeContext(context: unknown, depth = 0): unknown {
  if (context === null || context === undefined) return context;
  if (depth > 4) return '<truncated>';

  if (Array.isArray(context)) {
    return context.slice(0, 20).map((item) => sanitizeContext(item, depth + 1));
  }

  if (typeof context === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context as Record<string, unknown>)) {
      output[key] = REDACTED_KEYS.test(key) ? '<redacted>' : sanitizeContext(value, depth + 1);
    }
    return output;
  }

  if (typeof context === 'string') return context.slice(0, 1000);
  return context;
}

export interface CaptureParams {
  source: string;
  message: string;
  severity?: SystemEventSeverity;
  context?: Record<string, unknown>;
  /** Stack is taken from here when present, and the message defaults to it. */
  error?: unknown;
  /**
   * Use this as the identity instead of deriving one from the message.
   *
   * Normalizing a message is a heuristic, and a heuristic is the wrong tool
   * when the caller already knows the stable identity of the thing that broke.
   * A failing health check is "the scheduler check", however its summary is
   * worded this minute — and its summary deliberately contains live numbers,
   * which is exactly the input normalization is worst at.
   */
  fingerprintKey?: string;
}

export interface CapturedEvent {
  id: string;
  fingerprint: string;
  severity: SystemEventSeverity;
  source: string;
  message: string;
  count: number;
  /** True the first time this fingerprint is seen, or the first after a resolve. */
  isNew: boolean;
  lastAlertedAt: Date | null;
  /** Drives the escalating alert backoff — see alert.maybeSend. */
  firstSeenAt: Date;
}

/**
 * Record that something went wrong. Returns null if recording itself failed.
 *
 * The returned event is what `alert.service` decides on — capture does not
 * alert, because whether to wake someone depends on severity, cooldown and
 * volume, and mixing that decision in here would mean the request path waits
 * on an SMTP call.
 */
export async function captureError(params: CaptureParams): Promise<CapturedEvent | null> {
  try {
    const { source, error } = params;
    const severity = params.severity ?? 'ERROR';

    const message = (
      params.message ||
      (error instanceof Error ? error.message : String(error ?? 'Unknown error'))
    ).slice(0, 1000);

    const context = sanitizeContext({
      ...params.context,
      ...(error instanceof Error && error.stack
        ? { stack: error.stack.split('\n').slice(0, 12).join('\n') }
        : {}),
    }) as Record<string, unknown>;

    const fp = params.fingerprintKey
      ? crypto.createHash('sha1').update(params.fingerprintKey).digest('hex').slice(0, 32)
      : fingerprint(source, message);
    const now = new Date();

    // One statement rather than read-then-write: two instances reporting the
    // same defect at the same moment would otherwise both see "absent" and
    // race on the insert, and the unique index would turn the loser's report
    // into a second error inside the error reporter.
    const existing = await prisma.systemEvent.findUnique({
      where: { fingerprint: fp },
      select: { id: true, resolvedAt: true, lastAlertedAt: true },
    });

    // A defect that returns after being marked resolved is news again: the
    // resolution is cleared so it alerts rather than incrementing quietly.
    const reopened = Boolean(existing?.resolvedAt);

    const event = await prisma.systemEvent.upsert({
      where: { fingerprint: fp },
      create: {
        fingerprint: fp,
        severity,
        source,
        message,
        context: context as never,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: {
        count: { increment: 1 },
        lastSeenAt: now,
        // Latest wins: the most recent occurrence is the one with a live stack
        // and the context an operator is about to go looking at.
        message,
        context: context as never,
        severity,
        ...(reopened ? { resolvedAt: null, resolvedBy: null, lastAlertedAt: null } : {}),
      },
      select: {
        id: true,
        fingerprint: true,
        severity: true,
        source: true,
        message: true,
        count: true,
        lastAlertedAt: true,
        firstSeenAt: true,
      },
    });

    return { ...event, isNew: !existing || reopened };
  } catch (recordingFailure) {
    // The database is the most likely thing to be broken when an error is being
    // reported, and it is also where errors are reported to. stderr is the only
    // channel guaranteed to still exist; Render captures it.
    console.error('[observability] failed to record event:', recordingFailure);
    console.error('[observability] the original error was:', params.source, params.message);
    return null;
  }
}

/**
 * Mark the moment an alert went out, so the cooldown survives a restart.
 *
 * Held in the database rather than in memory because Render's free tier sleeps
 * and redeploys constantly, and an in-process timer resets on every wake — the
 * exact condition under which the same alert would be re-sent forever.
 */
export async function markAlerted(fingerprintOrId: string): Promise<void> {
  try {
    await prisma.systemEvent.updateMany({
      where: { OR: [{ id: fingerprintOrId }, { fingerprint: fingerprintOrId }] },
      data: { lastAlertedAt: new Date() },
    });
  } catch {
    // Losing the timestamp costs a duplicate alert later. Not worth propagating.
  }
}

// ─────────────────────────────────────────────────────────────
// JOB HEARTBEATS
// ─────────────────────────────────────────────────────────────

export async function recordJobStart(name: string): Promise<void> {
  try {
    await prisma.jobHeartbeat.upsert({
      where: { name },
      create: { name, lastStartedAt: new Date() },
      update: { lastStartedAt: new Date() },
    });
  } catch {
    // A missing heartbeat degrades the watchdog to "cannot tell", which it
    // handles. It must not stop the job itself from running.
  }
}

export async function recordJobSuccess(name: string, durationMs: number): Promise<void> {
  try {
    await prisma.jobHeartbeat.upsert({
      where: { name },
      create: { name, lastSucceededAt: new Date(), lastDurationMs: durationMs },
      update: {
        lastSucceededAt: new Date(),
        lastDurationMs: durationMs,
        consecutiveFailures: 0,
        lastError: null,
      },
    });
  } catch {
    /* see recordJobStart */
  }
}

export async function recordJobFailure(name: string, error: unknown): Promise<void> {
  try {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await prisma.jobHeartbeat.upsert({
      where: { name },
      create: { name, lastFailedAt: new Date(), lastError: message, consecutiveFailures: 1 },
      update: {
        lastFailedAt: new Date(),
        lastError: message,
        consecutiveFailures: { increment: 1 },
      },
    });
  } catch {
    /* see recordJobStart */
  }
}

// ─────────────────────────────────────────────────────────────
// READS — for the admin dashboard
// ─────────────────────────────────────────────────────────────

export async function listEvents(options: {
  includeResolved?: boolean;
  limit?: number;
} = {}) {
  const { includeResolved = false, limit = 50 } = options;

  return prisma.systemEvent.findMany({
    where: includeResolved ? {} : { resolvedAt: null },
    orderBy: [{ lastSeenAt: 'desc' }],
    take: Math.min(limit, 200),
  });
}

export async function resolveEvent(id: string, resolvedBy: string) {
  return prisma.systemEvent.update({
    where: { id },
    data: { resolvedAt: new Date(), resolvedBy },
  });
}

export async function listRemediations(limit = 50) {
  return prisma.remediationLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
  });
}

/**
 * Delete events and remediation records past the retention window.
 *
 * Resolved events go on the normal window; unresolved ones are kept regardless
 * of age, because an unresolved defect that stopped recurring is exactly the
 * thing you want still on screen when it comes back.
 */
export async function sweepOldEvents(): Promise<{ events: number; remediations: number }> {
  const cutoff = new Date(Date.now() - env.SYSTEM_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const events = await prisma.systemEvent.deleteMany({
    where: { resolvedAt: { not: null }, lastSeenAt: { lt: cutoff } },
  });

  const remediations = await prisma.remediationLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  return { events: events.count, remediations: remediations.count };
}

export const __testing = { normalize, fingerprint, sanitizeContext };
