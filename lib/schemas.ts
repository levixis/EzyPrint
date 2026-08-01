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

/** Parse a list response, dropping nothing and defaulting to empty. */
export function parseListResponse<T>(schema: z.ZodType<T>, data: unknown, context: string): T[] {
  return parseResponse(z.array(schema).catch([]), data, context);
}
