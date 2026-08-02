import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { calculateOrderPrice, isStudentPassActive } from './pricing.service';
import { creditOrderEarning } from './settlement.service';
import { enqueueShopEvent, publishQueued } from './realtime.service';
import { claimCancellationRefund, settleClaimedRefund } from './refund.service';
import { purgeOrderFiles, isTerminalForFiles } from './cleanup.service';
import * as notify from './notify.service';
import type { OrderStatus, PrintColor } from '@prisma/client';
import crypto from 'crypto';

/**
 * Order Service — full order lifecycle management.
 *
 * Flow: Create → Payment → Approval → Printing → Ready → Completed
 * Side paths: Cancel, Refund
 */

const orderSelect = {
  id: true,
  userId: true,
  shopId: true,
  shopName: true,
  status: true,
  fileName: true,
  fileType: true,
  fileStoragePath: true,
  fileSizeBytes: true,
  copies: true,
  color: true,
  pages: true,
  doubleSided: true,
  startPage: true,
  endPage: true,
  pageCost: true,
  baseFee: true,
  totalPrice: true,
  shopNotes: true,
  pickupCode: true,
  specialInstructions: true,
  userName: true,
  isPremiumOrder: true,
  razorpayOrderId: true,
  razorpayPaymentId: true,
  refundStatus: true,
  refundAmount: true,
  uploadedAt: true,
  cancelledAt: true,
  completedAt: true,
  files: true,
} as const;

/**
 * Which transitions each role may drive.
 *
 * `VALID_TRANSITIONS` answers "is this a legal state change?"; this answers
 * "is this person allowed to make it?". Having only the first meant any
 * authenticated student could drive any order — including READY_FOR_PICKUP ->
 * COMPLETED on a stranger's order, which credits that shop's ledger.
 *
 * A student's window closes when printing starts: paper and toner are spent by
 * then, so the commitment is real. The shop keeps a cancel at every stage,
 * because a jammed printer or an unreadable file has to be resolvable without
 * involving an admin. ADMIN falls through to the full table.
 */
const TRANSITIONS_BY_ROLE: Record<string, Partial<Record<OrderStatus, OrderStatus[]>>> = {
  STUDENT: {
    PENDING_PAYMENT: ['CANCELLED', 'PAYMENT_FAILED'],
    PENDING_APPROVAL: ['CANCELLED'],
    // Retry or give up. Nothing was charged, so cancelling costs nothing and
    // beats leaving a dead order in the student's list forever.
    PAYMENT_FAILED: ['PENDING_PAYMENT', 'CANCELLED'],
  },
  SHOP_OWNER: {
    PENDING_APPROVAL: ['PRINTING', 'CANCELLED'],
    PRINTING: ['READY_FOR_PICKUP', 'CANCELLED'],
    READY_FOR_PICKUP: ['COMPLETED', 'CANCELLED'],
  },
};

/**
 * Whether `role` may move an order from `from` to `to`.
 *
 * Exported for tests: these rules decide who can cancel a stranger's order and
 * who can trigger the earning credit, so they are worth pinning down.
 */
export function canRoleTransition(role: string, from: OrderStatus, to: OrderStatus): boolean {
  if (!(VALID_TRANSITIONS[from] || []).includes(to)) return false;
  if (role === 'ADMIN') return true;
  return (TRANSITIONS_BY_ROLE[role]?.[from] || []).includes(to);
}

// Valid status transitions — prevents invalid jumps
const VALID_TRANSITIONS: Record<string, OrderStatus[]> = {
  PENDING_PAYMENT: ['PENDING_APPROVAL', 'CANCELLED', 'PAYMENT_FAILED'],
  PENDING_APPROVAL: ['PRINTING', 'CANCELLED'],
  PRINTING: ['READY_FOR_PICKUP', 'CANCELLED'],
  READY_FOR_PICKUP: ['COMPLETED', 'CANCELLED'],
  COMPLETED: ['REFUNDED'],
  CANCELLED: [],
  // Cancellable as well as retryable: nothing was ever charged, so there is
  // nothing to refund and no reason to trap the order in a retry loop.
  PAYMENT_FAILED: ['PENDING_PAYMENT', 'CANCELLED'],
  REFUNDED: [],
};

// ────────────────────────────────────────────────────────────
// CREATE
// ────────────────────────────────────────────────────────────

interface CreateOrderInput {
  userId: string;
  shopId: string;
  specialInstructions?: string;
  userName?: string;
  isPremiumOrder?: boolean;
  files: Array<{
    fileName: string;
    fileType: string;
    fileStoragePath?: string;
    fileSizeBytes?: number;
    pageCount: number;
    color: PrintColor;
    copies: number;
    doubleSided: boolean;
  }>;
}

/**
 * Create a new print order.
 * Calculates pricing based on shop rates and creates the order in PENDING_PAYMENT status.
 */
export async function createOrder(input: CreateOrderInput) {
  // Verify shop exists, is approved, and is open
  const shop = await prisma.shop.findUnique({ where: { id: input.shopId } });
  if (!shop) throw ApiError.notFound('Shop not found');
  if (!shop.isApproved) throw ApiError.badRequest('Shop is not approved');
  if (!shop.isOpen) throw ApiError.badRequest('Shop is currently closed');
  if (shop.isArchived) throw ApiError.badRequest('Shop is archived');

  if (!input.files || input.files.length === 0) {
    throw ApiError.badRequest('At least one file is required');
  }

  // The Student Pass waives the base fee on small orders. It is read from the
  // database, never from the request — the client cannot grant itself a
  // discount by claiming to hold a pass.
  const student = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { hasStudentPass: true, studentPassActivatedAt: true },
  });
  const hasActivePass = isStudentPassActive(
    student?.hasStudentPass,
    student?.studentPassActivatedAt
  );

  const { pageCost, baseFee, totalPrice } = calculateOrderPrice(
    input.files,
    { bwPerPage: shop.bwPerPage, colorPerPage: shop.colorPerPage },
    hasActivePass
  );

  // Generate a 6-digit pickup code
  const pickupCode = crypto.randomInt(100000, 999999).toString();

  // Legacy fields fallback from first file
  const firstFile = input.files[0];

  const order = await prisma.order.create({
    data: {
      userId: input.userId,
      shopId: input.shopId,
      shopName: shop.name,
      fileName: firstFile.fileName,
      fileType: firstFile.fileType,
      fileStoragePath: firstFile.fileStoragePath,
      fileSizeBytes: firstFile.fileSizeBytes,
      copies: firstFile.copies,
      color: firstFile.color,
      pages: firstFile.pageCount,
      doubleSided: firstFile.doubleSided,
      pageCost,
      baseFee,
      totalPrice,
      pickupCode,
      specialInstructions: input.specialInstructions,
      userName: input.userName,
      isPremiumOrder: input.isPremiumOrder || false,
      status: 'PENDING_PAYMENT',
      files: {
        create: input.files.map((f) => ({
          fileName: f.fileName,
          fileType: f.fileType,
          fileStoragePath: f.fileStoragePath,
          fileSizeBytes: f.fileSizeBytes,
          pageCount: f.pageCount,
          color: f.color,
          copies: f.copies,
          doubleSided: f.doubleSided,
        })),
      },
    },
    select: orderSelect,
  });

  return {
    order,
    verifiedPrice: {
      pageCost,
      baseFee,
      totalPrice,
    }
  };
}

// ────────────────────────────────────────────────────────────
// READ
// ────────────────────────────────────────────────────────────

/**
 * Get a single order by ID. Verifies the requester has access.
 */
export async function getOrderById(orderId: string, requesterId: string, requesterType: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      ...orderSelect,
      user: { select: { id: true, name: true, email: true } },
      shop: { select: { id: true, name: true, ownerUserId: true } },
    },
  });

  if (!order) throw ApiError.notFound('Order not found');

  // Access control: student sees own, shop owner sees their shop's, admin sees all
  if (requesterType === 'ADMIN' || (requesterType === 'STUDENT' && order.userId === requesterId) || (requesterType === 'SHOP_OWNER' && order.shop.ownerUserId === requesterId)) {
    return formatOrder(order);
  }

  throw ApiError.forbidden('You do not have access to this order');
}

/**
 * List orders for a student (their own orders).
 */
export async function listOrdersForStudent(userId: string, options?: {
  status?: OrderStatus;
  page?: number;
  limit?: number;
}) {
  const page = Math.max(1, options?.page || 1);
  const limit = Math.min(50, Math.max(1, options?.limit || 20));

  const where: Record<string, unknown> = { userId };
  if (options?.status) where.status = options.status;

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: orderSelect,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { uploadedAt: 'desc' },
    }),
    prisma.order.count({ where }),
  ]);

  return {
    orders: orders.map(formatOrder),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * List orders for a shop owner (their shop's orders).
 */
export async function listOrdersForShop(ownerUserId: string, options?: {
  status?: OrderStatus;
  page?: number;
  limit?: number;
}) {
  // Find the shop owned by this user
  const shop = await prisma.shop.findUnique({ where: { ownerUserId } });
  if (!shop) throw ApiError.notFound('No shop found for this user');

  const page = Math.max(1, options?.page || 1);
  const limit = Math.min(50, Math.max(1, options?.limit || 20));

  const where: Record<string, unknown> = { shopId: shop.id };
  if (options?.status) where.status = options.status;

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: {
        ...orderSelect,
        user: { select: { id: true, name: true, email: true } },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { uploadedAt: 'desc' },
    }),
    prisma.order.count({ where }),
  ]);

  return {
    orders: orders.map(formatOrder),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Admin: list all orders across all shops.
 */
export async function listAllOrders(options?: {
  status?: OrderStatus;
  shopId?: string;
  page?: number;
  limit?: number;
}) {
  const page = Math.max(1, options?.page || 1);
  const limit = Math.min(100, Math.max(1, options?.limit || 20));

  const where: Record<string, unknown> = {};
  if (options?.status) where.status = options.status;
  if (options?.shopId) where.shopId = options.shopId;

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: {
        ...orderSelect,
        user: { select: { id: true, name: true, email: true } },
        shop: { select: { id: true, name: true } },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { uploadedAt: 'desc' },
    }),
    prisma.order.count({ where }),
  ]);

  return {
    orders: orders.map(formatOrder),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// ────────────────────────────────────────────────────────────
// STATUS UPDATES
// ────────────────────────────────────────────────────────────

/**
 * Update order status with validation of allowed transitions.
 * Only shop owners (for their orders) and admins can update status.
 */
export async function updateOrderStatus(
  orderId: string,
  newStatus: OrderStatus,
  requesterId: string,
  requesterType: string,
  shopNotes?: string
) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { shop: { select: { ownerUserId: true, financialVersion: true } } },
  });

  if (!order) throw ApiError.notFound('Order not found');

  // Access control
  if (requesterType === 'SHOP_OWNER' && order.shop.ownerUserId !== requesterId) {
    throw ApiError.forbidden('You do not own this shop');
  }
  // Without this a student could drive any order by id, not just their own.
  if (requesterType === 'STUDENT' && order.userId !== requesterId) {
    throw ApiError.forbidden('This is not your order');
  }

  // Legality of the transition, independent of who is asking.
  const legalTransitions = VALID_TRANSITIONS[order.status] || [];
  if (!legalTransitions.includes(newStatus)) {
    throw ApiError.badRequest(
      `Cannot transition from ${order.status} to ${newStatus}. Allowed: ${legalTransitions.join(', ') || 'none'}`
    );
  }

  // Then whether this role may make it.
  if (requesterType !== 'ADMIN') {
    const allowedForRole = TRANSITIONS_BY_ROLE[requesterType]?.[order.status] || [];
    if (!allowedForRole.includes(newStatus)) {
      throw ApiError.forbidden(
        order.status === 'PRINTING' && newStatus === 'CANCELLED' && requesterType === 'STUDENT'
          ? 'This order is already being printed and can no longer be cancelled. Please raise a refund request instead.'
          : `You are not allowed to change this order from ${order.status} to ${newStatus}.`
      );
    }
  }

  // Build update data
  const updateData: Record<string, unknown> = { status: newStatus };

  if (shopNotes !== undefined) {
    updateData.shopNotes = shopNotes;
  }

  if (newStatus === 'COMPLETED') {
    updateData.completedAt = new Date();
  } else if (newStatus === 'CANCELLED') {
    updateData.cancelledAt = new Date();
  }

  const outboxIds: string[] = [];
  let refundRequestId: string | null = null;

  const updated = await prisma.$transaction(async (tx) => {
    // Compare-and-swap on the status we validated against. Two staff acting on
    // the same order at once — one marking it Completed, the other Cancelled —
    // would otherwise both pass validation and the last write would silently
    // win. Now that completion moves money, that is a financial divergence, not
    // just a confusing UI.
    const applied = await tx.order.updateMany({
      where: { id: orderId, status: order.status },
      data: updateData,
    });

    if (applied.count === 0) {
      throw ApiError.conflict(
        'This order was updated by someone else. Refresh and try again.'
      );
    }

    // Fulfilment is what earns the shop its money.
    if (newStatus === 'COMPLETED') {
      await creditOrderEarning(tx, {
        id: order.id,
        shopId: order.shopId,
        pageCost: order.pageCost,
      });
    }

    // A cancelled order that was paid for must give the money back without the
    // student having to ask. Claimed inside this transaction so the refund
    // request cannot exist without the cancellation, nor the cancellation
    // without a claim on the refund.
    if (newStatus === 'CANCELLED') {
      refundRequestId = await claimCancellationRefund(tx, {
        id: order.id,
        shopId: order.shopId,
        userId: order.userId,
        totalPrice: order.totalPrice,
        razorpayPaymentId: order.razorpayPaymentId,
      });
    }

    const row = await tx.order.findUnique({ where: { id: orderId }, select: orderSelect });

    // Carries the shop's current version rather than a new one: an order status
    // change does not itself move a balance, so it is not part of the balance
    // sequence the client uses for gap detection. A COMPLETED transition
    // separately emits ledger.credited with an incremented sequence.
    const outboxId = await enqueueShopEvent(tx, {
      shopId: order.shopId,
      type: 'order.updated',
      seq: order.shop.financialVersion,
      data: { orderId, status: newStatus },
    });
    outboxIds.push(outboxId);

    return row;
  });

  await publishQueued(outboxIds);

  // After commit, and never awaited into the caller's latency: the transition
  // is what the student is waiting on, not the announcement of it.
  notify.notifyOrderStatus({
    orderId,
    shopId: order.shopId,
    studentUserId: order.userId,
    ownerUserId: order.shop.ownerUserId,
    newStatus,
    actorUserId: requesterId,
  });

  // Completion is also the moment the shop gets paid, and money warrants a
  // notification of its own rather than being folded into the status update.
  if (newStatus === 'COMPLETED') {
    notify.notifyEarningCredited({
      shopId: order.shopId,
      ownerUserId: order.shop.ownerUserId,
      orderId,
      amountPaise: order.pageCost,
    });
  }

  // The print job is done, so the documents are no longer needed. Deleting them
  // here rather than on a retention timer is deliberate: a student who wants the
  // same thing printed again re-uploads it, and we stop holding scanned IDs and
  // coursework for people who finished with us months ago.
  //
  // After the commit and outside any transaction — an R2 failure must not roll
  // back an order that is already complete. The row stays flagged as having a
  // file, so the retention sweep retries it.
  if (isTerminalForFiles(newStatus)) {
    purgeOrderFiles(orderId).catch((error) => {
      console.error(`[order] file cleanup failed for ${orderId}, leaving it to the sweep:`, error);
    });
  }

  // Outside the transaction: this makes a network call to Razorpay, which must
  // never run while holding database locks. The cancellation is already
  // committed, so a failure here leaves the request in PROCESSING_REFUND for an
  // admin to retry rather than rolling back a cancellation the user has
  // already been told succeeded. The Razorpay idempotency key makes that retry
  // safe.
  if (refundRequestId) {
    try {
      await settleClaimedRefund(refundRequestId, {
        setOrderRefunded: false,
        createdBy: 'SYSTEM',
        adminNote: 'Automatic refund for cancelled order',
      });
    } catch (error) {
      console.error(
        `[order] auto-refund failed for cancelled order ${orderId} ` +
        `(refund request ${refundRequestId}) — left in PROCESSING_REFUND:`,
        error
      );
    }
  }

  if (!updated) throw ApiError.notFound('Order not found');
  return formatOrder(updated);
}

// ────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────

function formatOrder(order: any) {
  return {
    ...order,
    shopName: order.shop?.name ?? order.shopName,
    printOptions: {
      copies: order.copies,
      color: order.color,
      pages: order.pages,
      doubleSided: order.doubleSided,
    },
    priceDetails: {
      pageCost: order.pageCost,
      baseFee: order.baseFee,
      totalPrice: order.totalPrice,
    },
  };
}

// ────────────────────────────────────────────────────────────
// PRICE VERIFICATION
// ────────────────────────────────────────────────────────────

export interface RepriceResult {
  /** True when the verified price differs from what the order currently says. */
  changed: boolean;
  previousTotal: number;
  totalPrice: number;
  /** Files whose format the server cannot count, so cannot price from. */
  unverifiable: string[];
}

/**
 * Recompute an order's price from page counts the server counted itself.
 *
 * `pageCount` on an order arrives from the browser and is the multiplier in
 * `pageCount × rate × copies`, so understating it understates the bill. Every
 * other pricing input already comes from the database — the shop's rates, the
 * student's pass — and this closes the last one.
 *
 * Called immediately before a Razorpay order is created, which is the last
 * point at which the price can still change without a student having been
 * charged. When the figure moves, the order is updated and the caller stops:
 * a student must never be charged more than the amount they were shown.
 *
 * The write is guarded on the total we just read and on PENDING_PAYMENT, so a
 * concurrent payment attempt that already claimed the order cannot have the
 * price changed underneath it.
 */
export async function repriceFromVerifiedPages(orderId: string): Promise<RepriceResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { files: true, shop: { select: { bwPerPage: true, colorPerPage: true } } },
  });
  if (!order) throw ApiError.notFound('Order not found');

  const unverifiable = order.files
    .filter((f) => f.verifiedPageCount == null)
    .map((f) => f.fileName);

  // Nothing to compare against yet — the caller decides whether that is fatal.
  if (unverifiable.length > 0) {
    return {
      changed: false,
      previousTotal: order.totalPrice,
      totalPrice: order.totalPrice,
      unverifiable,
    };
  }

  const student = await prisma.user.findUnique({
    where: { id: order.userId },
    select: { hasStudentPass: true, studentPassActivatedAt: true },
  });

  const { pageCost, baseFee, totalPrice } = calculateOrderPrice(
    order.files.map((f) => ({
      pageCount: f.verifiedPageCount as number,
      color: f.color,
      copies: f.copies,
      doubleSided: f.doubleSided,
    })),
    { bwPerPage: order.shop.bwPerPage, colorPerPage: order.shop.colorPerPage },
    isStudentPassActive(student?.hasStudentPass, student?.studentPassActivatedAt)
  );

  if (totalPrice === order.totalPrice) {
    return { changed: false, previousTotal: order.totalPrice, totalPrice, unverifiable: [] };
  }

  await prisma.order.updateMany({
    where: { id: orderId, status: 'PENDING_PAYMENT', totalPrice: order.totalPrice },
    data: {
      pageCost,
      baseFee,
      totalPrice,
      pages: order.files[0]?.verifiedPageCount ?? order.pages,
    },
  });

  return {
    changed: true,
    previousTotal: order.totalPrice,
    totalPrice,
    unverifiable: [],
  };
}
