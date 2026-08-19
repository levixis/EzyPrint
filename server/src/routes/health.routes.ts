import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { env } from '../config/env';

const router = Router();

/**
 * Which optional integrations are actually configured.
 *
 * Every one of these degrades silently when its credentials are absent: the
 * feature stops happening, one warning goes to a log nobody is reading, and
 * everything else carries on looking healthy. Push is the case that prompted
 * this — `FIREBASE_SERVICE_ACCOUNT` unset means `sendPushToUser` no-ops for
 * every order that goes to PRINTING or READY_FOR_PICKUP, in-app notifications
 * keep working so the app looks fine, and the first report is a student saying
 * they never heard their order was ready.
 *
 * Reported as configured/not, never the values themselves. This endpoint is
 * unauthenticated so it can answer a liveness probe, which means it must not
 * become a reconnaissance surface: "email: false" tells an operator what to fix
 * and tells an attacker nothing they can use.
 *
 * `false` is not automatically a failure — local development runs with most of
 * these empty on purpose. It is a failure when it disagrees with what the
 * environment is supposed to be, which is why the values sit next to
 * `environment` rather than folding into `status`.
 */
function integrationStatus() {
  return {
    /** FCM. False means no device notification is delivered, for anyone. */
    push: Boolean(env.FIREBASE_SERVICE_ACCOUNT),
    /** Pusher. False means the shop ledger falls back to refetching. */
    realtime: Boolean(env.PUSHER_APP_ID && env.PUSHER_KEY && env.PUSHER_SECRET),
    /** Resend or Gmail. False means no OTP or payout email leaves the server. */
    email: Boolean(env.RESEND_API_KEY || (env.GMAIL_USER && env.GMAIL_APP_PASSWORD)),
    /** Razorpay. False means no payment can be taken or refunded. */
    payments: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
    /** Webhook signature verification. False means deliveries cannot be trusted. */
    paymentWebhook: Boolean(env.RAZORPAY_WEBHOOK_SECRET),
    /**
     * Object storage. 'local' writes uploads to the container's ephemeral disk,
     * so they are lost on every deploy and restart.
     */
    storage: env.STORAGE_MODE,
    /** Background jobs. False means settlement and reconciliation never run. */
    scheduler: env.ENABLE_SCHEDULER,
  };
}

/**
 * GET /api/v1/health
 * Health check endpoint — verifies server and database connectivity.
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    // Verify database connection with a simple query
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      success: true,
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'connected',
      environment: process.env.NODE_ENV || 'development',
      integrations: integrationStatus(),
    });
  } catch {
    res.status(503).json({
      success: false,
      status: 'degraded',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      // Reported here too: a database outage is exactly when someone needs to
      // see the whole picture, not a payload with half of it missing.
      integrations: integrationStatus(),
    });
  }
});

export default router;
