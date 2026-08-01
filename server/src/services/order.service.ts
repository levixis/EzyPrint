import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { calculateOrderPrice } from './pricing.service';
import { creditOrderEarning } from './settlement.service';
import { enqueueShopEvent, publishQueued } from './realtime.service';
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

// Valid status transitions — prevents invalid jumps
const VALID_TRANSITIONS: Record<string, OrderStatus[]> = {
  PENDING_PAYMENT: ['PENDING_APPROVAL', 'CANCELLED', 'PAYMENT_FAILED'],
  PENDING_APPROVAL: ['PRINTING', 'CANCELLED'],
  PRINTING: ['READY_FOR_PICKUP', 'CANCELLED'],
  READY_FOR_PICKUP: ['COMPLETED', 'CANCELLED'],
  COMPLETED: ['REFUNDED'],
  CANCELLED: [],
  PAYMENT_FAILED: ['PENDING_PAYMENT'],
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

/**
 * A Student Pass lasts 30 days from activation.
 * Mirrors `isStudentPassActive` in the frontend's utils/pricing.ts.
 */
const PASS_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

function isStudentPassActive(hasPass?: boolean, activatedAt?: Date | null): boolean {
  if (!hasPass || !activatedAt) return false;
  return Date.now() < activatedAt.getTime() + PASS_DURATION_MS;
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

  // Validate status transition
  const allowedTransitions = VALID_TRANSITIONS[order.status] || [];
  if (!allowedTransitions.includes(newStatus)) {
    throw ApiError.badRequest(
      `Cannot transition from ${order.status} to ${newStatus}. Allowed: ${allowedTransitions.join(', ') || 'none'}`
    );
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
