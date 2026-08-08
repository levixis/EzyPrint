import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { runHealthChecks } from '../services/health.service';
import { runWatchdogCycle, listRemediations } from '../services/watchdog.service';
import {
  listEvents,
  listRemediations as listRemediationHistory,
  resolveEvent,
} from '../services/observability.service';

/**
 * Operator-facing system routes.
 *
 * Everything here is admin-only, and for a sharper reason than the rest of the
 * admin surface: health output names which dependency is down and why, which is
 * a reconnaissance gift to anyone deciding where to push. The unauthenticated
 * `/health` endpoint next door stays deliberately thin — up or not up — and
 * that is the one an uptime monitor should poll.
 */
const router = Router();

const adminOnly = [authenticate, authorize('ADMIN')];

/**
 * GET /api/v1/system/health
 *
 * The full report. `?deep=1` adds the two probes that leave the building
 * (R2 and Razorpay); without it the response is database queries only, which
 * is what makes it cheap enough for the dashboard to poll.
 */
router.get('/health', ...adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deep = req.query.deep === '1' || req.query.deep === 'true';
    const report = await runHealthChecks({ deep });
    res.json({ success: true, data: report });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/system/check
 *
 * Run a watchdog cycle now rather than waiting for the interval — including
 * whatever remediation it decides is warranted. Every safety rule still
 * applies: the circuit breaker, the rate limits and the precondition re-check
 * are properties of the cycle, not of the scheduler that usually calls it.
 * Triggering this by hand cannot make the watchdog do anything it would not do
 * on its own.
 */
router.post('/check', ...adminOnly, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await runWatchdogCycle();
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/system/events — distinct failures, most recently seen first.
 */
router.get('/events', ...adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const includeResolved = req.query.includeResolved === '1' || req.query.includeResolved === 'true';
    const limit = Number(req.query.limit) || 50;
    const events = await listEvents({ includeResolved, limit });
    res.json({ success: true, data: events });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/v1/system/events/:id/resolve
 *
 * Marks a defect handled. Not a delete: a resolved event still holds its
 * history, and a new occurrence reopens it and alerts again — a bug that comes
 * back is news, and silently folding it into the old row would hide that.
 */
router.patch('/events/:id/resolve', ...adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw ApiError.unauthorized();

    // Express 5 types a route param as string | string[]; a repeated param
    // would otherwise reach Prisma as an array and throw deep in the query.
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) throw ApiError.badRequest('An event id is required.');

    const event = await resolveEvent(id, req.user.userId);
    res.json({ success: true, data: event });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/system/remediations
 *
 * The audit trail: what the watchdog did, plus the catalogue of what it is
 * permitted to do. Both, because "it fixed something" is only reassuring
 * alongside the bounded list of things it is able to fix.
 */
router.get('/remediations', ...adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const [history, permitted] = await Promise.all([
      listRemediationHistory(limit),
      Promise.resolve(listRemediations()),
    ]);
    res.json({ success: true, data: { history, permitted } });
  } catch (error) {
    next(error);
  }
});

export default router;
