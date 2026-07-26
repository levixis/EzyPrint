import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';

/**
 * Shop Service — CRUD, admin actions, settings, and aggregate stats.
 */

const shopSelect = {
  id: true,
  ownerUserId: true,
  name: true,
  address: true,
  bwPerPage: true,
  colorPerPage: true,
  isOpen: true,
  isApproved: true,
  isArchived: true,
  isVerified: true,
  contactPhone: true,
  contactPhoneAlt: true,
  contactEmail: true,
  whatsappNumber: true,
  pendingBalance: true,
  ledgerBalance: true,
  debtAmount: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ────────────────────────────────────────────────────────────
// READ
// ────────────────────────────────────────────────────────────

/**
 * List shops visible to students — approved, not archived.
 * Optionally filter by isOpen.
 */
export async function listShopsForStudents(options?: { onlyOpen?: boolean }) {
  const where: Record<string, unknown> = {
    isApproved: true,
    isArchived: false,
  };

  if (options?.onlyOpen) {
    where.isOpen = true;
  }

  return prisma.shop.findMany({
    where,
    select: {
      id: true,
      name: true,
      address: true,
      bwPerPage: true,
      colorPerPage: true,
      isOpen: true,
      contactPhone: true,
      contactEmail: true,
      whatsappNumber: true,
    },
    orderBy: [{ isOpen: 'desc' }, { name: 'asc' }],
  });
}

/**
 * Admin: list ALL shops (including unapproved and archived).
 */
export async function listAllShops() {
  return prisma.shop.findMany({
    select: {
      ...shopSelect,
      owner: {
        select: { id: true, name: true, email: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Get a single shop by ID.
 */
export async function getShopById(shopId: string) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      ...shopSelect,
      owner: {
        select: { id: true, name: true, email: true },
      },
      payoutMethods: true,
    },
  });

  if (!shop) {
    throw ApiError.notFound('Shop not found');
  }

  return shop;
}

/**
 * Get the shop owned by a specific user.
 */
export async function getShopByOwnerId(ownerUserId: string) {
  return prisma.shop.findUnique({
    where: { ownerUserId },
    select: shopSelect,
  });
}

// ────────────────────────────────────────────────────────────
// UPDATE
// ────────────────────────────────────────────────────────────

/**
 * Shop owner updates their shop settings (pricing, open/close, contact info).
 * Validates that the user owns the shop.
 */
export async function updateShopSettings(
  shopId: string,
  ownerUserId: string,
  data: {
    bwPerPage?: number;
    colorPerPage?: number;
    isOpen?: boolean;
    contactPhone?: string;
    contactPhoneAlt?: string;
    contactEmail?: string;
    whatsappNumber?: string;
  }
) {
  // Verify ownership
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw ApiError.notFound('Shop not found');
  if (shop.ownerUserId !== ownerUserId) {
    throw ApiError.forbidden('You do not own this shop');
  }

  // Validate pricing
  if (data.bwPerPage !== undefined && data.bwPerPage < 0) {
    throw ApiError.badRequest('B/W price per page cannot be negative');
  }
  if (data.colorPerPage !== undefined && data.colorPerPage < 0) {
    throw ApiError.badRequest('Color price per page cannot be negative');
  }

  return prisma.shop.update({
    where: { id: shopId },
    data,
    select: shopSelect,
  });
}

// ────────────────────────────────────────────────────────────
// ADMIN ACTIONS
// ────────────────────────────────────────────────────────────

/**
 * Admin approves a shop — makes it visible to students.
 */
export async function approveShop(shopId: string) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw ApiError.notFound('Shop not found');
  if (shop.isApproved) throw ApiError.conflict('Shop is already approved');

  return prisma.shop.update({
    where: { id: shopId },
    data: { isApproved: true, isArchived: false },
    select: shopSelect,
  });
}

/**
 * Admin archives a shop — hides from students but keeps data.
 */
export async function archiveShop(shopId: string) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw ApiError.notFound('Shop not found');

  return prisma.shop.update({
    where: { id: shopId },
    data: { isArchived: true, isOpen: false },
    select: shopSelect,
  });
}

/**
 * Admin unarchives a shop.
 */
export async function unarchiveShop(shopId: string) {
  return prisma.shop.update({
    where: { id: shopId },
    data: { isArchived: false },
    select: shopSelect,
  });
}

// ────────────────────────────────────────────────────────────
// AGGREGATE STATS
// ────────────────────────────────────────────────────────────

/**
 * Get or compute aggregate stats for a shop dashboard.
 */
export async function getShopAggregate(shopId: string, ownerUserId: string) {
  // Verify the shop exists and the user owns it
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw ApiError.notFound('Shop not found');
  if (shop.ownerUserId !== ownerUserId) {
    throw ApiError.forbidden('You do not own this shop');
  }

  // Compute aggregate from orders
  const [orderStats, payoutStats] = await Promise.all([
    prisma.order.groupBy({
      by: ['status'],
      where: { shopId },
      _count: true,
      _sum: { totalPrice: true, baseFee: true },
    }),
    prisma.payout.aggregate({
      where: { shopId, status: 'PAID' },
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  const activeStatuses = ['PENDING_PAYMENT', 'PENDING_APPROVAL', 'PRINTING', 'READY_FOR_PICKUP'];
  let totalOrders = 0;
  let activeOrders = 0;
  let completedOrders = 0;
  let totalRevenue = 0;
  let totalBaseFees = 0;

  for (const stat of orderStats) {
    totalOrders += stat._count;
    totalRevenue += stat._sum.totalPrice || 0;
    totalBaseFees += stat._sum.baseFee || 0;

    if (stat.status === 'COMPLETED') {
      completedOrders = stat._count;
    }
    if (activeStatuses.includes(stat.status)) {
      activeOrders += stat._count;
    }
  }

  // Upsert aggregate for caching
  const aggregate = await prisma.shopAggregate.upsert({
    where: { shopId },
    create: {
      shopId,
      totalOrders,
      activeOrders,
      completedOrders,
      totalRevenue,
      totalBaseFees,
      totalPaidOut: payoutStats._sum.amount || 0,
      pendingPayouts: shop.pendingBalance,
      pendingPayoutCount: payoutStats._count,
    },
    update: {
      totalOrders,
      activeOrders,
      completedOrders,
      totalRevenue,
      totalBaseFees,
      totalPaidOut: payoutStats._sum.amount || 0,
      pendingPayouts: shop.pendingBalance,
      pendingPayoutCount: payoutStats._count,
    },
  });

  return aggregate;
}
