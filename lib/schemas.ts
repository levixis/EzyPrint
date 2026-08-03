import { z } from 'zod';

/**
 * Response schemas for the network boundary.
 *
 * `api.get<SupportTicket[]>(...)` tells TypeScript what we hope arrives and
 * checks nothing. That gap is how a list endpoint that sent a message *count*
 * satisfied a type declaring a message *array* — and why reading
 * `messages.length` blanked the whole page the first time a user had a ticket.
 * The compiler had no way to know.
 *
 * Two jobs here, and the second matters more than the first:
 *
 *   1. Report drift. A mismatch is logged with the exact field path, so the
 *      next shape change announces itself instead of surfacing as a blank
 *      screen days later.
 *
 *   2. Guarantee a renderable shape. Every collection carries `.catch([])`, so
 *      a missing or malformed array becomes an empty one rather than
 *      `undefined`. A component can then map over it safely no matter what the
 *      server sent. This is what actually prevents the crash — validation
 *      alone would only tell us about it afterwards.
 *
 * Deliberately permissive about unknown fields: the server adding a property
 * is not an error, and failing on it would make every backend change a
 * frontend outage.
 */

/** An array that degrades to empty rather than to undefined. */
const list = <T extends z.ZodTypeAny>(item: T) => z.array(item).catch([]);

/** Dates cross the wire as ISO strings; components format them themselves. */
const isoDate = z.string();

// ──────────────────────────────────────────────
// TICKETS
// ──────────────────────────────────────────────

export const ticketMessageSchema = z.object({
  id: z.string(),
  senderId: z.string(),
  senderName: z.string().catch('Unknown'),
  senderType: z.string(),
  message: z.string().catch(''),
  createdAt: isoDate.optional(),
}).loose();

export const ticketAttachmentSchema = z.object({
  id: z.string(),
  storageKey: z.string(),
  /** The reply this file was sent with; null for ticket-level attachments. */
  messageId: z.string().nullable().optional(),
  originalName: z.string().catch('attachment'),
  mimeType: z.string().optional(),
  sizeBytes: z.number().nullable().optional(),
}).loose();

export const ticketStatusChangeSchema = z.object({
  id: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  changedByName: z.string().catch('Unknown'),
  note: z.string().nullable().optional(),
  createdAt: isoDate.optional(),
}).loose();

export const supportTicketSchema = z.object({
  id: z.string(),
  subject: z.string().catch(''),
  status: z.string(),
  category: z.string(),
  raisedBy: z.string(),
  raisedByName: z.string().catch('Unknown'),
  // Every collection on a ticket is defaulted. Each one is a `.length` or
  // `.map` somewhere in the UI, and each is absent from at least one of the
  // endpoints that returns a ticket — which is how two separate screens were
  // blanked by two different missing arrays.
  messages: list(ticketMessageSchema),
  attachments: list(ticketAttachmentSchema),
  attachmentPaths: list(z.string()),
  statusHistory: list(ticketStatusChangeSchema),
  messageCount: z.number().optional(),
}).loose();

// ──────────────────────────────────────────────
// ORDERS
// ──────────────────────────────────────────────

export const orderFileSchema = z.object({
  id: z.string(),
  fileName: z.string().catch('file'),
  pageCount: z.number().catch(1),
  copies: z.number().catch(1),
}).loose();

export const orderSchema = z.object({
  id: z.string(),
  status: z.string(),
  shopId: z.string(),
  totalPrice: z.number().catch(0),
  files: list(orderFileSchema),
}).loose();

// ──────────────────────────────────────────────
// MONEY
// ──────────────────────────────────────────────

export const payoutSchema = z.object({
  id: z.string(),
  shopId: z.string(),
  status: z.string(),
  amount: z.number().catch(0),
}).loose();

export const ledgerEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  amount: z.number().catch(0),
}).loose();

export const refundRequestSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  status: z.string(),
}).loose();

// ──────────────────────────────────────────────
// ADMIN COLLECTIONS
// ──────────────────────────────────────────────

/**
 * Users, as the admin screens list them.
 *
 * The Student Pass panel reads this endpoint and maps over the result, so an
 * absent `users` key blanks that tab.
 */
export const userSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  type: z.string().optional(),
  studentPassActivatedAt: z.string().nullable().optional(),
  studentPassPaymentId: z.string().nullable().optional(),
}).loose();

/** Referral codes, mapped over in the admin referrals screen. */
export const referralCodeSchema = z.object({
  id: z.string(),
  code: z.string(),
  usedBy: z.string().nullable().optional(),
  usedAt: isoDate.nullable().optional(),
  expiresAt: isoDate.nullable().optional(),
}).loose();

/**
 * Shop reactivation requests.
 *
 * This endpoint returned its array at the top level and was typed straight into
 * `ReactivationRequest[]` with nothing between — the only collection left with
 * no defence of any kind, and it renders on the admin dashboard.
 */
export const reactivationRequestSchema = z.object({
  id: z.string(),
  shopId: z.string(),
  shopName: z.string().catch('Unknown shop'),
  status: z.string(),
  requestedAt: isoDate.optional(),
  rejectionReason: z.string().nullable().optional(),
}).loose();

// ──────────────────────────────────────────────
// NOTIFICATIONS
// ──────────────────────────────────────────────

/**
 * The bell.
 *
 * Its list is spread into an array alongside the session-local toasts
 * (`[...localNotifications, ...serverNotifications]`) and then sorted on
 * `timestamp`. Spreading `undefined` throws, so an endpoint that answered
 * without a `notifications` key would take out every screen that renders the
 * header — which is all of them.
 *
 * The two names for the same instant are both accepted. The server returns the
 * Prisma row as-is, so its field is `createdAt`; session-local toasts are built
 * client-side against `NotificationMessage`, so theirs is `timestamp`. Nothing
 * mapped between them.
 *
 * `timestamp` used to carry `.catch(() => new Date(0).toISOString())` to keep
 * the sort total. Because no server notification has ever had a `timestamp`
 * field, that catch fired on every single one and stamped them all with the
 * Unix epoch — so the whole notification tray read "56y ago". The mistake was
 * using a default to paper over a *missing* field: it converts a shape
 * mismatch into a confident wrong answer, which is far harder to notice than a
 * blank. Before this schema existed the field was simply `undefined` and the
 * time rendered as nothing, which was ugly but honest.
 *
 * So: read whichever name is present, and if neither is, leave it undefined.
 * `timeAgo` already renders nothing for an unusable date, and the sort in
 * AppContext now orders undefined last instead of relying on a sentinel.
 */
export const notificationSchema = z.object({
  id: z.string(),
  message: z.string().catch(''),
  timestamp: isoDate.optional(),
  createdAt: isoDate.optional(),
  read: z.boolean().catch(false),
  type: z.string().optional(),
  orderId: z.string().nullable().optional(),
  targetUserId: z.string().nullable().optional(),
  targetShopId: z.string().nullable().optional(),
}).loose().transform(({ createdAt, ...rest }) => ({
  ...rest,
  timestamp: rest.timestamp ?? createdAt,
}));

// ──────────────────────────────────────────────
// PARSING
// ──────────────────────────────────────────────

/**
 * Validate a response, log any drift, and hand back something renderable.
 *
 * Never throws. A schema failure here would turn a cosmetic backend change
 * into a white screen — the exact outcome this exists to prevent. Because the
 * collections above carry `.catch([])`, the recovered value is still safe to
 * render even when individual fields were wrong.
 */
export function parseResponse<T>(schema: z.ZodType<T>, data: unknown, context: string): T {
  const result = schema.safeParse(data);

  if (result.success) return result.data;

  console.error(
    `[api] ${context}: response did not match the expected shape.`,
    result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
  );

  return data as T;
}

/**
 * Parse a list response, keeping every row that is usable.
 *
 * This was `parseResponse(z.array(schema).catch([]), ...)`, which had two
 * problems that only show up together.
 *
 * The `.catch([])` recovered *before* `parseResponse` could inspect the
 * failure, so nothing was ever logged — list drift was silent, which is the
 * opposite of this module's first stated job.
 *
 * And zod validates an array as a unit: one unusable row failed the whole
 * parse, and the catch then replaced *every* row with none. A single malformed
 * ledger entry emptied a shop's entire ledger, so the dashboard showed no
 * activity and "Today's Earnings ₹0" with nothing in the console. That is worse
 * than the crash this module exists to prevent, because a crash gets noticed
 * and an empty page that should not be empty does not.
 *
 * Row by row instead: good rows survive their neighbours, bad ones are dropped
 * with their index and the reason, and the result is always an array.
 */
export function parseListResponse<T>(schema: z.ZodType<T>, data: unknown, context: string): T[] {
  if (!Array.isArray(data)) {
    console.error(
      `[api] ${context}: expected a list, received ${data === null ? 'null' : typeof data}. ` +
      `Rendering as empty.`
    );
    return [];
  }

  const kept: T[] = [];
  const dropped: string[] = [];

  data.forEach((row, index) => {
    const result = schema.safeParse(row);
    if (result.success) {
      kept.push(result.data);
      return;
    }
    dropped.push(
      `[${index}] ${result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`
    );
  });

  if (dropped.length > 0) {
    console.error(
      `[api] ${context}: dropped ${dropped.length} of ${data.length} items that did not match the expected shape.`,
      dropped
    );
  }

  return kept;
}
