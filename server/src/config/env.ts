import dotenv from 'dotenv';
import path from 'path';

// Load .env from server root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Centralized environment configuration.
 *
 * Fix 6 (Audit): Added RAZORPAY_WEBHOOK_SECRET — was being read
 * directly from process.env in the controller, bypassing this config.
 *
 * Fix 10 (Audit): In production, missing JWT secrets or Razorpay keys
 * will throw immediately on startup instead of silently falling back
 * to insecure defaults.
 */

const NODE_ENV = process.env.NODE_ENV || 'development';
const isDev = NODE_ENV === 'development';
const isProd = NODE_ENV === 'production';

// ── Production secret validation ──
// In production, these MUST be set. Falling back to 'dev-access-secret'
// in prod would mean anyone could forge JWTs.
function requireInProd(name: string, value: string | undefined, fallback: string): string {
  if (isProd && !value) {
    throw new Error(`❌ Missing required environment variable: ${name}. Cannot start in production without it.`);
  }
  return value || fallback;
}

export const env = {
  NODE_ENV,
  PORT: parseInt(process.env.PORT || '5000', 10),
  DATABASE_URL: process.env.DATABASE_URL || '',

  // JWT
  JWT_ACCESS_SECRET: requireInProd('JWT_ACCESS_SECRET', process.env.JWT_ACCESS_SECRET, 'dev-access-secret'),
  JWT_REFRESH_SECRET: requireInProd('JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET, 'dev-refresh-secret'),
  JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',

  // CORS
  CORS_ORIGINS: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim()),

  // Razorpay
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || '',
  RAZORPAY_KEY_SECRET: requireInProd('RAZORPAY_KEY_SECRET', process.env.RAZORPAY_KEY_SECRET, ''),
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || '',

  // Storage (file uploads)
  STORAGE_MODE: (process.env.STORAGE_MODE || 'local') as 'local' | 's3',
  S3_BUCKET: process.env.S3_BUCKET || '',
  S3_REGION: process.env.S3_REGION || 'auto',
  S3_ENDPOINT: process.env.S3_ENDPOINT || '',  // For R2: https://<account_id>.r2.cloudflarestorage.com
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY || '',
  S3_SECRET_KEY: process.env.S3_SECRET_KEY || '',
  LOCAL_UPLOAD_DIR: process.env.LOCAL_UPLOAD_DIR || 'uploads',

  // Helpers
  isDev,
  isProd,
} as const;
