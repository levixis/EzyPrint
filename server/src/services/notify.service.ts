import { prisma } from '../utils/prisma';
import { sendPushToUser, type PushChannel } from './push.service';
import { sendNoticeEmail } from './email.service';
import type { NotificationType, OrderStatus, TicketStatus } from '@prisma/client';

/**
 * Notification routing — who hears about what.
 *
 * Every notification is two things: a durable `Notification` row that populates
 * the in-app bell, and a best-effort push that buzzes the device. The row is
 * the source of truth. Push is a courtesy copy and is never awaited by the
 * caller, so a slow or failing FCM cannot add latency to an order transition.
 *
 * Routing is decided here rather than at each call site, because "who should
 * hear about this" is a property of the event, not of the code that happens to
 * trigger it. An order moving to PRINTING concerns the student who is waiting
 * for it; a new paid order concerns the shop that has to print it. Getting that
 * backwards is how a shop ends up buzzing for its own button presses.
 *
 * The guiding rule throughout: never notify someone about their own action.
 */

interface NotifyInput {
  message: string;
  type?: NotificationType;
  /** Push title. Defaults to the app name. */
  title?: string;
  channel?: PushChannel;
  orderId?: string;
  targetShopId?: string;
  /** Extra key/values for the push payload, used for deep-linking on tap. */
  data?: Record<string, string>;
  /**
   * Also send an email. Present on a minority of events, by design.
   *
   * The bell and the push assume someone opens the app. That assumption holds
   * for orders, which are minutes long and watched. It fails exactly where the
   * stakes are highest: a shop owner waiting on their application has no reason
   * to open the app for days, and a payout decision concerns money that has
   * already left. Those people need to be reached where they already are.
   *
   * It is opt-in per event rather than on by default because the same reasoning
   * inverts for order updates — a student ordering twice a week would get
   * hundreds of emails a term, and an inbox that noisy gets filtered, taking
   * the payout emails with it.
   */
  email?: {
    subject: string;
    heading: string;
    lines: string[];
    detail?: string;
    tone?: 'good' | 'bad';
  };
}

/**
 * Email one user, if we have an address for them.
 *
 * Never throws and is never awaited by a business flow. `User.email` is
 * nullable, and an account without one is not an error — it just cannot be
 * emailed, and the in-app row already recorded the event either way.
 */
async function emailUser(userId: string, content: NonNullable<NotifyInput['email']>): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user?.email) return;

  await sendNoticeEmail({ to: user.email, ...content });
}

/**
 * Write the in-app row, then fire the push without blocking.
 *
 * A failed insert propagates — if we cannot record the notification, the caller
 * should know. A failed push does not; it is swallowed inside push.service.
 */
async function notifyUser(userId: string, input: NotifyInput): Promise<void> {
  await prisma.notification.create({
    data: {
      recipientUserId: userId,
      message: input.message,
      type: input.type ?? 'info',
      orderId: input.orderId,
      targetShopId: input.targetShopId,
    },
  });

  void sendPushToUser(userId, {
    title: input.title ?? 'EzyPrint',
    body: input.message,
    channel: input.channel ?? 'ezyprint_account',
    data: {
      ...input.data,
      ...(input.orderId ? { orderId: input.orderId } : {}),
    },
  });

  // Same contract as push: a courtesy copy that cannot delay or fail the row.
  if (input.email) {
    void emailUser(userId, input.email).catch((error) =>
      console.error('[notify] email copy failed:', error)
    );
  }
}

/**
 * Fan out to several people at once.
 *
 * `allSettled` because one recipient's failure must not silently drop the
 * others — a student still needs their update even if an admin row failed.
 */
async function notifyMany(userIds: string[], input: NotifyInput): Promise<void> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const results = await Promise.allSettled(unique.map((id) => notifyUser(id, input)));

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[notify] delivery failed for one recipient:', result.reason);
    }
  }
}

/** Every admin account. Admins are few, so a full scan is fine. */
async function adminUserIds(): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { type: 'ADMIN' },
    select: { id: true },
  });
  return admins.map((admin) => admin.id);
}

/**
 * Nothing below may throw into a business flow.
 *
 * A notification is an announcement about work that has already been committed.
 * Letting a failed announcement bubble up would roll back — or appear to roll
 * back — an order transition that genuinely happened.
 */
function guard(promise: Promise<void>, label: string): void {
  promise.catch((error) => console.error(`[notify] ${label} failed:`, error));
}

// ────────────────────────────────────────────────────────────
// ORDERS  →  student (their order) + shop owner (their work queue)
// ────────────────────────────────────────────────────────────

/** Human-facing wording per status, from each side's point of view. */
const STATUS_COPY: Partial<Record<OrderStatus, { student: string; type: NotificationType }>> = {
  PRINTING: { student: 'The shop has started printing your order.', type: 'info' },
  READY_FOR_PICKUP: { student: 'Your order is ready for pickup.', type: 'success' },
  COMPLETED: { student: 'Your order is complete. Thanks for using EzyPrint!', type: 'success' },
  CANCELLED: { student: 'Your order was cancelled.', type: 'warning' },
  REFUNDED: { student: 'Your refund has been processed.', type: 'success' },
  PAYMENT_FAILED: { student: 'Your payment did not go through. No money was taken.', type: 'error' },
  // PENDING_APPROVAL is deliberately absent: the student has just come back
  // from the payment sheet and is looking at the confirmation. Buzzing them
  // about a transition they are watching happen is noise.
};

/**
 * A paid order has arrived and the shop needs to act on it.
 *
 * This is the single most time-critical notification in the product — the
 * student is standing at the counter — so it is the one that most needs to
 * reach a device that is not currently looking at the app.
 */
export function notifyNewOrder(order: {
  id: string;
  shopId: string;
  userName?: string | null;
  ownerUserId: string;
}): void {
  guard(
    notifyUser(order.ownerUserId, {
      message: `New order from ${order.userName || 'a student'} — tap to view and start printing.`,
      title: 'New print order',
      type: 'info',
      channel: 'ezyprint_orders',
      orderId: order.id,
      targetShopId: order.shopId,
    }),
    'new order'
  );
}

/**
 * An order changed hands. Both parties may care, but only about changes they
 * did not make themselves.
 */
export function notifyOrderStatus(params: {
  orderId: string;
  shopId: string;
  studentUserId: string;
  ownerUserId: string;
  newStatus: OrderStatus;
  /** Who pressed the button — excluded from the fan-out. */
  actorUserId: string;
}): void {
  const copy = STATUS_COPY[params.newStatus];
  if (!copy) return;

  const recipients: Promise<void>[] = [];

  if (params.actorUserId !== params.studentUserId) {
    recipients.push(
      notifyUser(params.studentUserId, {
        message: copy.student,
        title: 'Order update',
        type: copy.type,
        channel: 'ezyprint_orders',
        orderId: params.orderId,
      })
    );
  }

  // The shop only needs to hear about the student's side of the exchange. Its
  // own status presses are already reflected on screen.
  if (params.actorUserId !== params.ownerUserId && params.newStatus === 'CANCELLED') {
    recipients.push(
      notifyUser(params.ownerUserId, {
        message: 'A student cancelled their order. No action needed.',
        title: 'Order cancelled',
        type: 'warning',
        channel: 'ezyprint_orders',
        orderId: params.orderId,
        targetShopId: params.shopId,
      })
    );
  }

  guard(Promise.all(recipients).then(() => undefined), 'order status');
}

// ────────────────────────────────────────────────────────────
// TICKETS  →  raiser + admins + the shop it concerns
// ────────────────────────────────────────────────────────────

/** Everyone party to a ticket, minus whoever just acted. */
async function ticketAudience(
  ticket: { raisedBy: string; shopId: string | null },
  excludeUserId?: string
): Promise<{ raiser: string | null; admins: string[]; shopOwner: string | null }> {
  const [admins, shop] = await Promise.all([
    adminUserIds(),
    ticket.shopId
      ? prisma.shop.findUnique({ where: { id: ticket.shopId }, select: { ownerUserId: true } })
      : Promise.resolve(null),
  ]);

  return {
    raiser: ticket.raisedBy === excludeUserId ? null : ticket.raisedBy,
    admins: admins.filter((id) => id !== excludeUserId),
    shopOwner:
      shop?.ownerUserId && shop.ownerUserId !== excludeUserId ? shop.ownerUserId : null,
  };
}

/**
 * A ticket was opened.
 *
 * Admins always hear about it — they are the support desk. The shop hears only
 * when the ticket is filed against it, which is what makes tickets a shop-side
 * notification category rather than an admin-only one.
 */
export function notifyTicketCreated(ticket: {
  id: string;
  subject: string;
  raisedBy: string;
  raisedByName: string;
  shopId: string | null;
}): void {
  guard(
    (async () => {
      const audience = await ticketAudience(ticket, ticket.raisedBy);

      await notifyMany(audience.admins, {
        message: `New support ticket from ${ticket.raisedByName}: "${ticket.subject}"`,
        title: 'New support ticket',
        type: 'info',
        channel: 'ezyprint_tickets',
        data: { ticketId: ticket.id },
      });

      if (audience.shopOwner) {
        await notifyUser(audience.shopOwner, {
          message: `A ticket was raised about your shop: "${ticket.subject}"`,
          title: 'Ticket about your shop',
          type: 'warning',
          channel: 'ezyprint_tickets',
          targetShopId: ticket.shopId ?? undefined,
          data: { ticketId: ticket.id },
        });
      }
    })(),
    'ticket created'
  );
}

/** Someone replied. Everyone else on the thread hears about it. */
export function notifyTicketReply(params: {
  ticketId: string;
  subject: string;
  raisedBy: string;
  shopId: string | null;
  senderId: string;
  senderName: string;
}): void {
  guard(
    (async () => {
      const audience = await ticketAudience(
        { raisedBy: params.raisedBy, shopId: params.shopId },
        params.senderId
      );

      await notifyMany(
        [audience.raiser, audience.shopOwner, ...audience.admins].filter(
          (id): id is string => Boolean(id)
        ),
        {
          message: `${params.senderName} replied to "${params.subject}"`,
          title: 'New reply',
          type: 'info',
          channel: 'ezyprint_tickets',
          targetShopId: params.shopId ?? undefined,
          data: { ticketId: params.ticketId },
        }
      );
    })(),
    'ticket reply'
  );
}

/** A ticket was resolved, closed or reopened. */
export function notifyTicketStatus(params: {
  ticketId: string;
  subject: string;
  raisedBy: string;
  shopId: string | null;
  newStatus: TicketStatus;
  actorUserId: string;
}): void {
  const wording: Partial<Record<TicketStatus, { text: string; type: NotificationType }>> = {
    IN_REVIEW: { text: 'is now being looked into', type: 'info' },
    RESOLVED: { text: 'has been resolved', type: 'success' },
    CLOSED: { text: 'has been closed', type: 'info' },
  };
  const copy = wording[params.newStatus];
  if (!copy) return;

  guard(
    (async () => {
      const audience = await ticketAudience(
        { raisedBy: params.raisedBy, shopId: params.shopId },
        params.actorUserId
      );

      await notifyMany(
        [audience.raiser, audience.shopOwner].filter((id): id is string => Boolean(id)),
        {
          message: `Your ticket "${params.subject}" ${copy.text}.`,
          title: 'Ticket update',
          type: copy.type,
          channel: 'ezyprint_tickets',
          targetShopId: params.shopId ?? undefined,
          data: { ticketId: params.ticketId },
        }
      );
    })(),
    'ticket status'
  );
}

// ────────────────────────────────────────────────────────────
// MONEY  →  shop owner (their earnings) + admins (their queue)
// ────────────────────────────────────────────────────────────

/** An order completed and the shop was credited. */
export function notifyEarningCredited(params: {
  shopId: string;
  ownerUserId: string;
  orderId: string;
  amountPaise: number;
}): void {
  const rupees = (params.amountPaise / 100).toFixed(2);
  guard(
    notifyUser(params.ownerUserId, {
      message: `₹${rupees} earned. It will be available to withdraw after clearing.`,
      title: 'Payment earned',
      type: 'success',
      channel: 'ezyprint_account',
      orderId: params.orderId,
      targetShopId: params.shopId,
    }),
    'earning credited'
  );
}

/**
 * A refund reached the student's account.
 *
 * The one notification the "never notify someone about their own action" rule
 * must not suppress. A student who cancels a paid order is the actor, so
 * notifyOrderStatus deliberately stays silent — but settlement happens minutes
 * or days later, through Razorpay and sometimes an admin, and by then it is no
 * longer their action. Without this the money simply reappears with no word
 * from us, and the student is left refreshing the order to find out whether it
 * worked.
 *
 * Sent on the account channel because it names an amount, and that channel is
 * the one that keeps its contents off the lockscreen.
 */
export function notifyRefundSettled(params: {
  studentUserId: string;
  orderId: string;
  shopId: string;
  amountPaise: number;
  /** False when nothing went back through the gateway — cash or a free order. */
  throughGateway: boolean;
}): void {
  const rupees = (params.amountPaise / 100).toFixed(2);
  guard(
    notifyUser(params.studentUserId, {
      message: params.throughGateway
        ? `₹${rupees} has been refunded to your original payment method. It can take 5-7 working days to appear.`
        : `₹${rupees} has been refunded for your order. Please collect it from the shop.`,
      title: 'Refund processed',
      type: 'success',
      channel: 'ezyprint_account',
      orderId: params.orderId,
      targetShopId: params.shopId,
    }),
    'refund settled'
  );
}

/**
 * An admin approved or rejected a shop's application.
 *
 * Nothing announced this before — not in-app, not push, not email. A shop owner
 * who registered had no way to learn the outcome except opening the app and
 * inferring it from what the dashboard let them do. That is the single longest
 * wait anyone has in this product, and it ended in silence.
 *
 * Emailed rather than pushed alone: an applicant may not have the app installed
 * on the device they registered from, and may not open it for days.
 */
export function notifyShopDecision(params: {
  shopId: string;
  ownerUserId: string;
  shopName: string;
  approved: boolean;
  /** The admin's reason. Only meaningful on a rejection. */
  reason?: string | null;
}): void {
  const message = params.approved
    ? `${params.shopName} has been approved. You can start accepting orders.`
    : `${params.shopName} was not approved.${params.reason ? ` ${params.reason}` : ''}`;

  guard(
    notifyUser(params.ownerUserId, {
      message,
      title: params.approved ? 'Shop approved' : 'Shop application update',
      type: params.approved ? 'success' : 'warning',
      channel: 'ezyprint_account',
      targetShopId: params.shopId,
      email: params.approved
        ? {
            subject: `${params.shopName} is approved on EzyPrint`,
            heading: 'Your shop has been approved',
            lines: [
              `${params.shopName} is live and students can now find it and place orders.`,
              'Open EzyPrint to set your pricing and opening hours before your first order arrives.',
            ],
            tone: 'good',
          }
        : {
            subject: `About your EzyPrint application for ${params.shopName}`,
            heading: 'Your shop application was not approved',
            lines: [
              `We could not approve ${params.shopName} at this time.`,
              'If you think this is a mistake, reply to this email or raise a support ticket in the app.',
            ],
            // Without the reason this email creates a support ticket instead of
            // resolving one, so it is the part most worth getting through.
            detail: params.reason ?? undefined,
            tone: 'bad',
          },
    }),
    'shop decision'
  );
}

/**
 * A payout changed state — the shop always cares about its own money.
 *
 * `emailSubject` is set by the caller for admin-driven changes only. A shop
 * requesting, disputing or confirming its own payout does not need an email
 * telling it what it just did.
 */
export function notifyPayoutUpdate(params: {
  shopId: string;
  ownerUserId: string;
  message: string;
  type?: NotificationType;
  emailSubject?: string;
  emailDetail?: string;
}): void {
  guard(
    notifyUser(params.ownerUserId, {
      message: params.message,
      title: 'Payout update',
      type: params.type ?? 'info',
      channel: 'ezyprint_account',
      targetShopId: params.shopId,
      email: params.emailSubject
        ? {
            subject: params.emailSubject,
            heading: 'Payout update',
            lines: [params.message, 'Open EzyPrint to see your balance and payout history.'],
            detail: params.emailDetail,
            tone: params.type === 'warning' || params.type === 'error' ? 'bad' : 'good',
          }
        : undefined,
    }),
    'payout update'
  );
}

/** Something landed in the admin queue and needs a human decision. */
export function notifyAdmins(message: string, type: NotificationType = 'info'): void {
  guard(
    (async () => {
      const admins = await adminUserIds();
      await notifyMany(admins, {
        message,
        title: 'Admin action needed',
        type,
        channel: 'ezyprint_account',
      });
    })(),
    'admin notice'
  );
}
