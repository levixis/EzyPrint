import { Router } from 'express';

import healthRoutes from './health.routes';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import shopRoutes from './shop.routes';
import orderRoutes from './order.routes';
import payoutRoutes from './payout.routes';
import ticketRoutes from './ticket.routes';
import notificationRoutes from './notification.routes';
import uploadRoutes from './upload.routes';
import paymentRoutes from './payment.routes';
import adminRoutes from './admin.routes';
import referralRoutes from './referral.routes';
import reactivationRoutes from './reactivation.routes';
import refundRoutes from './refund.routes';
import realtimeRoutes from './realtime.routes';
import systemRoutes from './system.routes';

const router = Router();

/**
 * API v1 route aggregator.
 *
 * All routes are prefixed with /api/v1 (set in the main server file).
 * This keeps the entry point clean and makes versioning easy.
 *
 * Route structure:
 *   /api/v1/health          → Health check
 *   /api/v1/auth/*          → Authentication (login, register, OAuth)
 *   /api/v1/users/*         → User profile management
 *   /api/v1/shops/*         → Shop CRUD + admin actions
 *   /api/v1/orders/*        → Order lifecycle
 *   /api/v1/payouts/*       → Payout management + ledger
 *   /api/v1/tickets/*       → Support ticket system
 *   /api/v1/notifications/* → In-app notifications
 *   /api/v1/referrals/*     → Referral system
 *   /api/v1/realtime/*      → Pusher channel auth + balance snapshot
 *   /api/v1/system/*        → Health report, error log, watchdog audit (admin)
 */
router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/shops', shopRoutes);
router.use('/orders', orderRoutes);
router.use('/payouts', payoutRoutes);
router.use('/tickets', ticketRoutes);
router.use('/notifications', notificationRoutes);
router.use('/uploads', uploadRoutes);
router.use('/payments', paymentRoutes);
router.use('/admin', adminRoutes);
router.use('/referrals', referralRoutes);
router.use('/reactivation', reactivationRoutes);
router.use('/refunds', refundRoutes);
router.use('/realtime', realtimeRoutes);
router.use('/system', systemRoutes);

export default router;
