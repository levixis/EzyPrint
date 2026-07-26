import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';

const router = Router();

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
    });
  } catch {
    res.status(503).json({
      success: false,
      status: 'degraded',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
    });
  }
});

export default router;
