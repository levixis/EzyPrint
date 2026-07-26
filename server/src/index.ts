import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { env } from './config/env';
import { generalLimiter } from './middleware/rateLimiter';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import routes from './routes';
import { prisma } from './utils/prisma';

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

// ── Security Headers ──
app.use(helmet());

// ── CORS ──
app.use(
  cors({
    origin: env.CORS_ORIGINS,
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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
    // Verify database connection on startup
    await prisma.$connect();
    console.log('✅ Database connected successfully');

    app.listen(env.PORT, () => {
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
  } catch (error) {
    console.error('💥 Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
const shutdown = async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startServer();

export default app;
