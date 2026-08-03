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
  EMAIL_FROM: process.env.EMAIL_FROM || `"EzyPrint Security" <${process.env.GMAIL_USER || 'noreply@ezyprint.in'}>`,

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

  // ── Helpers ──
  isDev,
  isProd,
  isTest,
} as const;
