import dotenv from 'dotenv';
import path from 'path';

// Load .env from server root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Centralized environment configuration.
 *
 * Secrets fall back to insecure development defaults ONLY when NODE_ENV is
 * explicitly 'development'. Any other value — 'production', 'staging', a typo,
 * or unset — fails startup rather than silently booting with a well-known
 * secret. Falling back on an unrecognized NODE_ENV would mean a misspelled
 * deploy variable hands out forgeable JWTs.
 */

const NODE_ENV = process.env.NODE_ENV || 'development';
const isDev = NODE_ENV === 'development';
const isProd = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

/**
 * Require a secret outside of development/test.
 *
 * Fails closed: the fallback applies only when NODE_ENV is exactly
 * 'development' or 'test', never on an unrecognized value.
 */
function requireSecret(name: string, value: string | undefined, devFallback: string): string {
  if (value) return value;

  if (isDev || isTest) {
    if (devFallback) {
      console.warn(
        `⚠️  ${name} is not set — using an insecure development fallback. ` +
        `This is fatal outside NODE_ENV=development.`
      );
    }
    return devFallback;
  }

  throw new Error(
    `❌ Missing required environment variable: ${name} (NODE_ENV=${NODE_ENV}). ` +
    `Cannot start without it.`
  );
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`❌ Environment variable ${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

export const env = {
  NODE_ENV,
  PORT: intFromEnv('PORT', 5000),
  DATABASE_URL: process.env.DATABASE_URL || '',

  /**
   * Number of reverse proxies in front of the app, for express `trust proxy`.
   *
   * Railway/Vercel terminate at one edge proxy, so 1 is correct there. Without
   * it express-rate-limit keys every request on the proxy's address, collapsing
   * per-client limits into one global bucket.
   */
  TRUST_PROXY_HOPS: intFromEnv('TRUST_PROXY_HOPS', 1),

  // ── JWT ──
  JWT_ACCESS_SECRET: requireSecret('JWT_ACCESS_SECRET', process.env.JWT_ACCESS_SECRET, 'dev-access-secret'),
  JWT_REFRESH_SECRET: requireSecret('JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET, 'dev-refresh-secret'),
  JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',

  // ── CORS ──
  CORS_ORIGINS: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim()),

  /**
   * Google OAuth client IDs, comma-separated.
   *
   * Verified against the `aud` claim on every incoming Google token. Without
   * this check a token minted for ANY other Google application is accepted,
   * which is a full account-takeover path.
   *
   * A list rather than a single value because the Capacitor build uses separate
   * web, Android and iOS clients, all of which are legitimate audiences.
   */
  GOOGLE_CLIENT_IDS: requireSecret('GOOGLE_CLIENT_IDS', process.env.GOOGLE_CLIENT_IDS, '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  // ── Razorpay ──
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || '',
  RAZORPAY_KEY_SECRET: requireSecret('RAZORPAY_KEY_SECRET', process.env.RAZORPAY_KEY_SECRET, ''),
  // Without this, webhook signatures cannot be verified and payments stop being
  // processed. It must never be optional in a real deployment.
  RAZORPAY_WEBHOOK_SECRET: requireSecret('RAZORPAY_WEBHOOK_SECRET', process.env.RAZORPAY_WEBHOOK_SECRET, ''),

  // ── Storage (file uploads) ──
  STORAGE_MODE: (process.env.STORAGE_MODE || 'local') as 'local' | 's3',
  S3_BUCKET: process.env.S3_BUCKET || '',
  S3_REGION: process.env.S3_REGION || 'auto',
  S3_ENDPOINT: process.env.S3_ENDPOINT || '',  // For R2: https://<account_id>.r2.cloudflarestorage.com
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY || '',
  S3_SECRET_KEY: process.env.S3_SECRET_KEY || '',
  LOCAL_UPLOAD_DIR: process.env.LOCAL_UPLOAD_DIR || 'uploads',

  // ── Email (Gmail SMTP for OTP) ──
  GMAIL_USER: process.env.GMAIL_USER || '',
  GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD || '',
  /**
   * Resend API key, for delivering mail over HTTPS instead of SMTP.
   *
   * Render blocks outbound traffic to ports 25, 465 and 587 on free web
   * services, so nodemailer cannot deliver from there however correct the Gmail
   * credentials are. Set this and mail goes out over HTTP, which no port policy
   * touches. Leave it empty and SMTP is used, which is right locally and on any
   * host that permits it.
   */
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  /**
   * The From address. Must be on a domain verified with the mail provider —
   * `onboarding@resend.dev` works untouched for testing, but only delivers to
   * the address that owns the Resend account.
   *
   * Defaults to the Gmail user so existing deploys behave exactly as before.
   */
  EMAIL_FROM: process.env.EMAIL_FROM || `"EzyPrint Security" <${process.env.GMAIL_USER || 'noreply@ezyprint.co.in'}>`,

  /**
   * Where operational alerts go — the human who gets woken up.
   *
   * Separate from the admin *accounts* in the database on purpose. Alerts fire
   * when things are broken, and "query the users table for admins" is a step
   * that itself fails when the database is the thing that is down. This address
   * is read from the environment and needs nothing working to be known.
   *
   * Falls back to GMAIL_USER **in production only**.
   *
   * That fallback used to apply everywhere, and GMAIL_USER is set in every
   * local `.env` — so a dev server running on a laptop mailed the operator
   * about a laptop. Sleeping machines stop the scheduler and idle Neon
   * connections drop, so a development run generates exactly the alerts that
   * mean nothing and train you to ignore the ones that do.
   *
   * Locally you now get alerts only by naming an address on purpose.
   */
  ALERT_EMAIL: process.env.ALERT_EMAIL || (isProd ? process.env.GMAIL_USER || '' : ''),

  // ── Pusher (real-time shop ledger) ──
  PUSHER_APP_ID: requireSecret('PUSHER_APP_ID', process.env.PUSHER_APP_ID, ''),
  PUSHER_KEY: requireSecret('PUSHER_KEY', process.env.PUSHER_KEY, ''),
  PUSHER_SECRET: requireSecret('PUSHER_SECRET', process.env.PUSHER_SECRET, ''),
  PUSHER_CLUSTER: process.env.PUSHER_CLUSTER || 'ap2',

  // ── Push notifications (FCM) ──
  /**
   * Firebase service account JSON, for FCM only — no Firestore, no Auth.
   *
   * Left optional deliberately. FCM is the one part of the notification path
   * that cannot work without external credentials, and a missing key must
   * degrade to "in-app notification only" rather than take the server down:
   * the Notification row is the durable record, the push is a courtesy copy.
   * Accepts either raw JSON or base64. Prefer base64: the private key is
   * multi-line, and pasting it into a dashboard env field (Render, Railway)
   * either mangles the newlines or silently truncates at the first one.
   */
  FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT || '',

  // ── Student Pass ──
  /** Price of a 30-day Student Pass, in paise. */
  STUDENT_PASS_PRICE_PAISE: intFromEnv('STUDENT_PASS_PRICE_PAISE', 4900),

  // ── Settlement ──
  /**
   * Days after the day it was earned that money becomes withdrawable. T+1.
   *
   * Replaces SETTLEMENT_DELAY_HOURS, which was added to the earning time and
   * then rounded up to the release hour. Compounding the two put a cliff at
   * (release hour − delay): work finished at 05:59 cleared next morning, work
   * finished at 06:01 waited a further day. Shortening the hold only moved the
   * cliff — see computeAvailableAt for why counting days is the fix.
   */
  SETTLEMENT_DELAY_DAYS: intFromEnv('SETTLEMENT_DELAY_DAYS', 1),
  /**
   * Hour of day (IST, 0-23) at which cleared earnings are released.
   *
   * Rounding up to a fixed daily hour is what lets the dashboard promise an
   * exact time ("available Thu 3 Aug, 6:00 AM") the moment money is earned,
   * instead of showing a vague rolling window.
   */
  SETTLEMENT_RELEASE_HOUR_IST: intFromEnv('SETTLEMENT_RELEASE_HOUR_IST', 6),

  /**
   * What to do when an order's files no longer match the ones its price was
   * computed from.
   *
   *   'log'     — compare, record the mismatch loudly, and fulfil anyway
   *   'enforce' — refuse to hand the order to the shop; flag it for a human
   *
   * Defaults to 'log', and the default is the conservative one on purpose. This
   * check sits on the path where a student has *already paid*, so the failure
   * mode of getting it wrong in the enforce direction is refusing real orders
   * from real customers who did nothing wrong. The failure mode of getting it
   * wrong in the log direction is that a fraud we would have caught is instead
   * only recorded — and the upload guard, which is hard-enforced and needs no
   * flag, is what actually stops that fraud happening. This is the second line,
   * so it is the one that gets to be cautious.
   *
   * Ship on 'log', watch the logs for false positives across a full checkout
   * cycle, then set 'enforce'. It is an environment variable rather than a
   * constant precisely so that switch is not a redeploy — and so it can be
   * switched *back* in seconds if it starts refusing good orders at 2am.
   */
  FINGERPRINT_VERIFY: (process.env.FINGERPRINT_VERIFY === 'enforce' ? 'enforce' : 'log') as
    | 'enforce'
    | 'log',

  // ── Background scheduler ──
  ENABLE_SCHEDULER: boolFromEnv('ENABLE_SCHEDULER', !isTest),
  SETTLEMENT_SWEEP_INTERVAL_MS: intFromEnv('SETTLEMENT_SWEEP_INTERVAL_MS', 5 * 60 * 1000),
  RECONCILE_INTERVAL_MS: intFromEnv('RECONCILE_INTERVAL_MS', 15 * 60 * 1000),
  /**
   * How often to ask Razorpay what it was paid and check we have an order for
   * each. Hourly rather than every 15 minutes because it reads the gateway's
   * whole payment list, and the failures it catches — a lost row, a restore
   * that rolled past a capture — are not the kind that get worse in an hour.
   */
  PAYMENT_AUDIT_INTERVAL_MS: intFromEnv('PAYMENT_AUDIT_INTERVAL_MS', 60 * 60 * 1000),
  /**
   * How often to ask Razorpay how the refunds we are still waiting on ended.
   *
   * The `refund.processed` / `refund.failed` webhooks are ticked by hand in the
   * dashboard, per mode, and have never delivered a single event here. Until
   * they do, this poll is the *only* thing that ends a refund: without it the
   * student is told their money is on the way and never told it arrived, the
   * shop is never debited, and the order's files are pinned by the unsettled
   * refund forever.
   *
   * Every 15 minutes, matching the payment reconciliation, because it queries
   * only refunds already flagged stale and does nothing when there are none.
   */
  REFUND_RECONCILE_INTERVAL_MS: intFromEnv('REFUND_RECONCILE_INTERVAL_MS', 15 * 60 * 1000),
  /**
   * How long a refund may sit in PROCESSING_REFUND before the poll asks about it.
   *
   * A grace period, not a deadline. Razorpay usually settles in minutes but is
   * entitled to take days, and asking immediately would spend a gateway call
   * per refund to be told what we already know. Nothing is judged at this
   * threshold — a refund the gateway still calls pending is left alone.
   */
  REFUND_STUCK_MINUTES: intFromEnv('REFUND_STUCK_MINUTES', 30),
  OUTBOX_DISPATCH_INTERVAL_MS: intFromEnv('OUTBOX_DISPATCH_INTERVAL_MS', 10 * 1000),
  /** How often to retry file deletions the inline purge missed. */
  FILE_RETENTION_SWEEP_INTERVAL_MS: intFromEnv('FILE_RETENTION_SWEEP_INTERVAL_MS', 60 * 60 * 1000),
  // ── Shop-initiated refunds ──
  /**
   * How much a shop can refund on its own authority before an admin is needed.
   *
   * Requiring an admin for every refund is the wrong control. A refund returns
   * money to the payer's original card or UPI, so a compromised shop account
   * cannot extract anything with one — it can only hand that shop's own
   * earnings back to people who genuinely paid. Payouts are the operation that
   * moves money to an account the shop controls, and those keep their OTP gate.
   *
   * What actually bounds refund abuse is velocity, which is what payment
   * processors use: a cap per refund, and caps on count and value per day.
   * Beyond any of them the request escalates to an admin exactly as before, so
   * the limits shape the blast radius rather than the permission.
   */
  SHOP_REFUND_MAX_PER_REFUND_PAISE: intFromEnv('SHOP_REFUND_MAX_PER_REFUND_PAISE', 50_000),
  SHOP_REFUND_MAX_PER_DAY_COUNT: intFromEnv('SHOP_REFUND_MAX_PER_DAY_COUNT', 10),
  SHOP_REFUND_MAX_PER_DAY_PAISE: intFromEnv('SHOP_REFUND_MAX_PER_DAY_PAISE', 200_000),

  /**
   * How often to delete referral codes that expired unredeemed.
   *
   * Daily, not hourly: codes are issued with a 7-day expiry and then sit for a
   * 30-day grace period, so nothing about this is time-sensitive to the hour,
   * and every extra tick is Neon compute spent finding nothing.
   */
  REFERRAL_SWEEP_INTERVAL_MS: intFromEnv('REFERRAL_SWEEP_INTERVAL_MS', 24 * 60 * 60 * 1000),

  // ── Watchdog / self-healing ──
  /**
   * Master kill switch for automatic remediation.
   *
   * Detection, alerting and the health endpoint are unaffected by this — only
   * the part that *acts* is disabled. If a remediation is ever implicated in an
   * incident, this turns off the acting without turning off the seeing, which
   * is the state you want while diagnosing.
   */
  ENABLE_WATCHDOG: boolFromEnv('ENABLE_WATCHDOG', !isTest),
  /** How often the watchdog runs its checks and considers remediating. */
  WATCHDOG_INTERVAL_MS: intFromEnv('WATCHDOG_INTERVAL_MS', 2 * 60 * 1000),
  /**
   * Consecutive failures of one remediation before its circuit opens and the
   * watchdog stops trying and escalates to a human instead.
   *
   * Three, because the failure modes worth retrying (a dropped connection, a
   * gateway 502, a lock held by a dying replica) clear inside three attempts,
   * and anything that survives three identical attempts is a real defect that
   * more attempts will not fix — it will only bury the alert under retries.
   */
  WATCHDOG_CIRCUIT_THRESHOLD: intFromEnv('WATCHDOG_CIRCUIT_THRESHOLD', 3),
  /** How long an open circuit stays open before a single trial attempt. */
  WATCHDOG_CIRCUIT_COOLDOWN_MS: intFromEnv('WATCHDOG_CIRCUIT_COOLDOWN_MS', 30 * 60 * 1000),
  /**
   * A scheduler job is considered stalled when this much time has passed
   * beyond its own interval without a completed run.
   *
   * A multiplier rather than a fixed number, because the intervals span 10
   * seconds (outbox) to 24 hours (referral sweep) and one threshold cannot
   * serve both. Three times the interval tolerates two missed ticks, which a
   * cold start or a slow Neon wake can legitimately cause.
   */
  WATCHDOG_STALL_MULTIPLIER: intFromEnv('WATCHDOG_STALL_MULTIPLIER', 3),
  /**
   * Consecutive cycles a check must fail before a human is told.
   *
   * Two, because the most common failure here is not a fault at all: Neon
   * closes idle connections and suspends on the free tier, so a single cycle
   * can fail with "Server has closed the connection" and the next one
   * reconnects and passes. Paging on the first failure meant paging on
   * housekeeping.
   *
   * Remediation is unaffected and still runs on the first failure — retrying a
   * dropped connection is exactly the cheap, idempotent thing the watchdog
   * should do immediately. It is only *waking a person* that waits for
   * confirmation.
   */
  WATCHDOG_ESCALATE_AFTER: intFromEnv('WATCHDOG_ESCALATE_AFTER', 2),

  // ── Alerting ──
  /**
   * Minimum gap between two alerts about the same fingerprint.
   *
   * Without this, one failing endpoint hit by a class of 300 students is 300
   * identical emails, and the alert channel becomes something you mute — which
   * is strictly worse than having no alerting, because you believe you have it.
   */
  ALERT_COOLDOWN_MS: intFromEnv('ALERT_COOLDOWN_MS', 15 * 60 * 1000),
  /** Hard ceiling on alert emails per hour, across all fingerprints. */
  ALERT_MAX_PER_HOUR: intFromEnv('ALERT_MAX_PER_HOUR', 12),
  /** Days to keep system events before the sweep deletes them. */
  SYSTEM_EVENT_RETENTION_DAYS: intFromEnv('SYSTEM_EVENT_RETENTION_DAYS', 30),

  // ── Helpers ──
  isDev,
  isProd,
  isTest,
} as const;

/**
 * Configuration that must be right in production, checked at boot.
 *
 * `requireSecret` above covers the values whose absence is obvious — a missing
 * JWT secret cannot be mistaken for a working one. This function covers the
 * opposite and more dangerous class: values that are *present, valid, and
 * wrong*, where the server starts cleanly and the damage is silent.
 *
 * Every check here is one that has a real failure attached to it:
 *
 *  - STORAGE_MODE defaulting to 'local' writes student uploads to Render's
 *    ephemeral container disk. The order is paid, the shop sees it, and the
 *    file is gone at the next deploy. Nothing in the request path errors.
 *  - A test Razorpay key in production takes real checkout attempts and fails
 *    every one of them, or worse, appears to succeed against test money.
 *  - EMAIL_FROM on resend.dev delivers only to the Resend account owner, so
 *    password resets, payout OTPs and account-deletion codes are all issued,
 *    all logged as sent, and all arrive nowhere.
 *
 * Throwing at boot means Render's deploy fails loudly and the previous good
 * instance keeps serving, which is the correct outcome for every one of these.
 */
export function assertProductionConfig(): void {
  if (!isProd) return;

  const problems: string[] = [];

  // ── Storage ──
  if (env.STORAGE_MODE !== 's3') {
    problems.push(
      `STORAGE_MODE is "${env.STORAGE_MODE}", which writes uploads to the container's ` +
      `ephemeral disk — they are lost on every deploy and every restart. Set STORAGE_MODE=s3.`
    );
  } else {
    for (const [name, value] of Object.entries({
      S3_BUCKET: env.S3_BUCKET,
      S3_ENDPOINT: env.S3_ENDPOINT,
      S3_ACCESS_KEY: env.S3_ACCESS_KEY,
      S3_SECRET_KEY: env.S3_SECRET_KEY,
    })) {
      if (!value) problems.push(`STORAGE_MODE=s3 but ${name} is empty.`);
    }
  }

  // ── Razorpay ──
  if (!env.RAZORPAY_KEY_ID) {
    problems.push('RAZORPAY_KEY_ID is empty — checkout cannot be opened.');
  } else if (env.RAZORPAY_KEY_ID.startsWith('rzp_test_')) {
    problems.push(
      'RAZORPAY_KEY_ID is a TEST key in production. Real payments cannot be collected. ' +
      'Switch to the rzp_live_ key and regenerate RAZORPAY_WEBHOOK_SECRET — the live-mode ' +
      'webhook has a different signing secret than the test-mode one.'
    );
  }

  // ── Email ──
  if (!env.RESEND_API_KEY && !env.GMAIL_APP_PASSWORD) {
    problems.push(
      'No mail transport configured (RESEND_API_KEY and GMAIL_APP_PASSWORD both empty). ' +
      'Password reset, payout OTP and account deletion all silently fail.'
    );
  }
  if (/resend\.dev/i.test(env.EMAIL_FROM)) {
    problems.push(
      `EMAIL_FROM is "${env.EMAIL_FROM}", which is Resend's shared testing sender. It ` +
      'delivers ONLY to the mailbox that owns the Resend account — every other recipient ' +
      'gets nothing. Set it to an address on your verified domain.'
    );
  }
  if (!env.ALERT_EMAIL) {
    problems.push('ALERT_EMAIL is empty — nobody is told when the app breaks.');
  }

  if (problems.length > 0) {
    throw new Error(
      `\n❌ Refusing to start in production with this configuration:\n\n` +
      problems.map((p, i) => `  ${i + 1}. ${p}`).join('\n\n') +
      `\n\nFix these in the host's environment settings and redeploy.\n`
    );
  }
}
