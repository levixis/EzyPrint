import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
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
  fileName: string;
  fileType: string;
  fileStoragePath?: string;
  fileSizeBytes?: number;
  copies: number;
  color: PrintColor;
  pages: number;
  doubleSided: boolean;
  startPage?: number;
  endPage?: number;
  specialInstructions?: string;
  userName?: string;
  isPremiumOrder?: boolean;
  files?: Array<{
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

  // Calculate pricing
  const pricePerPage = input.color === 'COLOR' ? shop.colorPerPage : shop.bwPerPage;
  const effectivePages = input.doubleSided ? Math.ceil(input.pages / 2) : input.pages;
  const pageCost = effectivePages * input.copies * pricePerPage;
  const baseFee = calculateBaseFee(pageCost);
  const totalPrice = pageCost + baseFee;

  // Generate a 6-digit pickup code
  const pickupCode = crypto.randomInt(100000, 999999).toString();

  // Create order with optional multi-file support
  const order = await prisma.order.create({
    data: {
      userId: input.userId,
      shopId: input.shopId,
      shopName: shop.name,
      fileName: input.fileName,
      fileType: input.fileType,
      fileStoragePath: input.fileStoragePath,
      fileSizeBytes: input.fileSizeBytes,
      copies: input.copies,
      color: input.color,
      pages: input.pages,
      doubleSided: input.doubleSided,
      startPage: input.startPage,
      endPage: input.endPage,
      pageCost,
      baseFee,
      totalPrice,
      pickupCode,
      specialInstructions: input.specialInstructions,
      userName: input.userName,
      isPremiumOrder: input.isPremiumOrder || false,
      status: 'PENDING_PAYMENT',
      // Create associated files if multi-file order
      ...(input.files && input.files.length > 0
        ? {
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
          }
        : {}),
    },
    select: orderSelect,
  });

  return order;
}

/**
 * Base fee calculation — platform fee on top of page cost.
 * Matches the existing pricing utility from the frontend.
 */
function calculateBaseFee(pageCost: number): number {
  if (pageCost <= 5) return 2;
  if (pageCost <= 20) return 3;
  if (pageCost <= 50) return 5;
  return Math.ceil(pageCost * 0.1); // 10% for larger orders
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
  if (requesterType === 'ADMIN') return order;
  if (requesterType === 'STUDENT' && order.userId === requesterId) return order;
  if (requesterType === 'SHOP_OWNER' && order.shop.ownerUserId === requesterId) return order;

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
    orders,
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
    orders,
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
    orders,
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
    include: { shop: { select: { ownerUserId: true } } },
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

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: updateData,
    select: orderSelect,
  });

  return updated;
}
