import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { env, assertProductionConfig } from './config/env';
import { generalLimiter } from './middleware/rateLimiter';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import routes from './routes';
import { prisma } from './utils/prisma';
import { sanitizeBody, additionalSecurityHeaders } from './middleware/security';
import { startScheduler, stopScheduler } from './services/scheduler.service';
import { startWatchdog, stopWatchdog } from './services/watchdog.service';
import { captureError } from './services/observability.service';
import * as alert from './services/alert.service';

/**
 * EzyPrint Backend Server
 *
 * Architecture: Routes → Controllers → Services → Prisma (Repository)
 *
 * Middleware stack (order matters):
 *   1. Helmet (security headers)
 *   2. CORS (cross-origin requests)
 *   3. Morgan (request logging)
 *   4. Body parsing (JSON + URL-encoded)
 *   5. Rate limiting
 *   6. API routes
 *   7. 404 handler
 *   8. Error handler (must be last)
 */

const app = express();

// ── Proxy trust ──
// Railway and Vercel terminate TLS at an edge proxy, so the client address
// arrives in X-Forwarded-For. Without this, req.ip is the proxy's address and
// every rate limiter collapses into a single global bucket — 20 bad logins
// would lock out the whole user base. Set to the exact hop count rather than
// `true`, since blanket trust lets a client spoof X-Forwarded-For.
app.set('trust proxy', env.TRUST_PROXY_HOPS);

// ── Security Headers ──
app.use(helmet());

// ── CORS ──
/**
 * The origins the Capacitor shell serves the packaged app from.
 *
 * These are not addresses on the internet — nobody can navigate a browser to
 * `capacitor://localhost`, and `https://localhost` resolves to the device
 * itself. They identify the mobile app whose bundle we ship, and the WebView
 * sends them as `Origin` on every request.
 *
 * Held in code rather than left to CORS_ORIGINS because they are a property of
 * shipping a Capacitor app, not of any one deployment. As an env var they have
 * to be remembered for every environment, and forgetting produces a request
 * that returns 200 with no ACAO header — which reaches the app as "Failed to
 * fetch" and looks like the backend is down.
 */
const NATIVE_APP_ORIGINS = [
  'https://localhost',      // Capacitor Android (default androidScheme since v3)
  'capacitor://localhost',  // Capacitor iOS
];

app.use(
  cors({
    origin: [...env.CORS_ORIGINS, ...NATIVE_APP_ORIGINS],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ── Request Logging ──
// 'dev' format for development (colored, concise)
// 'combined' for production (Apache-style, good for log aggregation)
app.use(morgan(env.isDev ? 'dev' : 'combined'));

// ── Body Parsing ──
app.use(express.json({
  limit: '10mb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Security: XSS Sanitization + Extra Headers ──
app.use(sanitizeBody);
app.use(additionalSecurityHeaders);

// ── Rate Limiting ──
app.use('/api/', generalLimiter);

// ── API Routes ──
app.use('/api/v1', routes);

// ── 404 catch-all ──
app.use(notFoundHandler);

// ── Centralized error handler (MUST be last) ──
app.use(errorHandler);

// ── Start Server ──
const startServer = async () => {
  try {
    // Refuse to start on a production configuration that is present, valid and
    // wrong — test payment keys, ephemeral storage, a mail sender that reaches
    // one mailbox. Before the listener binds, so a bad deploy fails and Render
    // keeps the previous instance serving instead of promoting a broken one.
    assertProductionConfig();

    // Verify database connection on startup
    await prisma.$connect();
    console.log('✅ Database connected successfully');

    const server = app.listen(env.PORT, () => {
      console.log(`
  ┌─────────────────────────────────────────┐
  │                                         │
  │   🖨️  EzyPrint API Server               │
  │                                         │
  │   Environment: ${env.NODE_ENV.padEnd(23)}│
  │   Port:        ${String(env.PORT).padEnd(23)}│
  │   API:         /api/v1                  │
  │   Health:      /api/v1/health           │
  │                                         │
  └─────────────────────────────────────────┘
      `);
    });

    // ── Background jobs ──
    // Settlement sweep, Razorpay reconciliation and real-time outbox dispatch.
    // Each takes a Postgres advisory lock, so running more than one instance is
    // safe.
    startScheduler();

    // ── Watchdog ──
    // Checks health on an interval, repairs the failures it has a safe and
    // idempotent remedy for, and escalates everything else. Started after the
    // scheduler so the first cycle sees real heartbeats rather than reporting
    // every job as missing.
    startWatchdog();

    // ── Graceful Shutdown ──
    // When Railway/Render sends SIGTERM (container restart, deploy, etc.),
    // we stop accepting new connections but let in-flight requests finish.
    // This prevents webhook processing from being killed mid-transaction.
    const shutdown = async (signal: string) => {
      console.log(`\n🛑 ${signal} received — shutting down gracefully...`);

      // Stop background jobs before draining, so no new work starts mid-drain.
      stopScheduler();
      stopWatchdog();

      // Stop accepting new connections, wait for in-flight to finish
      server.close(async () => {
        console.log('  ✓ All in-flight requests completed');
        await prisma.$disconnect();
        console.log('  ✓ Database disconnected');
        process.exit(0);
      });

      // Force kill after 30 seconds if requests don't finish.
      // .unref() ensures this timer doesn't prevent clean exit
      // if all requests finish before the timeout.
      setTimeout(() => {
        console.error('  ✗ Forced shutdown after 30s timeout');
        process.exit(1);
      }, 30_000).unref();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    console.error('💥 Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

// ── Fix 9: Process-level error handlers ──
// Catch errors thrown outside Express request handlers (e.g., in
// setTimeout, event listeners, background reconciliation jobs).
// Without these, the process crashes silently.
process.on('unhandledRejection', (reason: unknown) => {
  console.error('💥 UNHANDLED REJECTION:', reason);
  // Don't crash — log and let the server continue.
  void captureError({
    source: 'process',
    severity: 'ERROR',
    message: reason instanceof Error ? reason.message : `Unhandled rejection: ${String(reason)}`,
    error: reason,
  });
});

process.on('uncaughtException', (error: Error) => {
  console.error('💥 UNCAUGHT EXCEPTION:', error);

  // The process is about to exit, so the usual fire-and-forget pattern would
  // lose the report. Give the write and the alert a bounded window to land,
  // then exit regardless — a crash that is never reported is a crash that
  // repeats. CRITICAL because reaching here means the process died.
  const deadline = setTimeout(() => process.exit(1), 3000);
  deadline.unref();

  void (async () => {
    try {
      const event = await captureError({
        source: 'process',
        severity: 'CRITICAL',
        message: `Uncaught exception: ${error.message}`,
        error,
      });
      if (event) {
        await alert.maybeSend(event, {
          title: 'Server crashed (uncaught exception)',
          body: `${error.message}\n\nThe process is restarting. If this repeats, the restart loop will not resolve it.`,
        });
      }
    } finally {
      clearTimeout(deadline);
      // Uncaught exceptions leave the process in an undefined state. Exit and
      // let Render restart it.
      process.exit(1);
    }
  })();
});

export default app;
