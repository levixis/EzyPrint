import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import type { LedgerEntryType, LedgerCounterparty, LedgerCreatedBy } from '@prisma/client';

/**
 * Ledger Service — financial tracking for shops.
 *
 * Every monetary event creates an immutable, append-only ledger entry.
 * Uses an interactive Prisma transaction with optimistic concurrency
 * (financialVersion) to prevent race conditions on balance updates.
 *
 * Fix 3 (Audit): Changed from batch $transaction to interactive $transaction
 * so the shop row is read INSIDE the transaction, preventing two concurrent
 * requests from reading the same financialVersion and both succeeding.
 */

export async function createLedgerEntry(data: {
  shopId: string;
  type: LedgerEntryType;
  amount: number;
  description: string;
  counterparty: LedgerCounterparty;
  createdBy?: LedgerCreatedBy;
  orderId?: string;
  eventId?: string;
}) {
  // Interactive transaction — the shop read + balance update + entry create
  // all happen atomically. If two requests race, one will fail the version
  // check and get a Prisma "Record not found" error, which we catch.
  try {
    return await prisma.$transaction(async (tx) => {
      // Read shop INSIDE the transaction — this is the critical fix.
      // In PostgreSQL with Prisma's default isolation level (READ COMMITTED),
      // this ensures we see the latest committed version.
      const shop = await tx.shop.findUnique({ where: { id: data.shopId } });
      if (!shop) throw ApiError.notFound('Shop not found');

      // Calculate balance delta based on entry type
      let pendingDelta = 0;

      switch (data.type) {
        case 'ORDER_EARNING':
          pendingDelta = data.amount;
          break;
        case 'REFUND_DEDUCTION':
        case 'MANUAL_PAYOUT_DEDUCTION':
        case 'CLAWBACK':
        case 'PAYOUT':
          pendingDelta = -data.amount;
          break;
        case 'PAYOUT_CANCEL_REFUND':
        case 'PAYOUT_REJECT_REFUND':
          pendingDelta = data.amount;
          break;
        case 'ADJUSTMENT':
          pendingDelta = data.amount; // Can be negative
          break;
      }

      // Create the ledger entry
      const entry = await tx.ledgerEntry.create({
        data: {
          shopId: data.shopId,
          type: data.type,
          amount: data.amount,
          description: data.description,
          counterparty: data.counterparty,
          createdBy: data.createdBy || 'SYSTEM',
          orderId: data.orderId,
          eventId: data.eventId,
          status: 'PENDING',
        },
      });

      // Update shop balance with optimistic concurrency check.
      // The `where` includes financialVersion — if another transaction
      // already incremented it, this update will match 0 rows and Prisma
      // throws "Record to update not found", which we catch below.
      await tx.shop.update({
        where: {
          id: data.shopId,
          financialVersion: shop.financialVersion,
        },
        data: {
          pendingBalance: { increment: pendingDelta },
          financialVersion: { increment: 1 },
        },
      });

      return entry;
    });
  } catch (error: unknown) {
    // If Prisma threw because the version check failed (concurrent update),
    // convert to a user-friendly error instead of a raw 500.
    if (
      error instanceof Error &&
      error.message.includes('Record to update not found')
    ) {
      throw ApiError.conflict(
        'Concurrent balance update detected. Please retry the operation.'
      );
    }
    throw error;
  }
}

export async function getLedgerEntries(
  shopId: string,
  ownerUserId: string,
  options?: { page?: number; limit?: number; type?: LedgerEntryType }
) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw ApiError.notFound('Shop not found');
  if (shop.ownerUserId !== ownerUserId) throw ApiError.forbidden('Not your shop');

  const page = Math.max(1, options?.page || 1);
  const limit = Math.min(100, Math.max(1, options?.limit || 20));

  const where: Record<string, unknown> = { shopId };
  if (options?.type) where.type = options.type;

  const [entries, total] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.ledgerEntry.count({ where }),
  ]);

  return {
    entries,
    currentBalance: shop.pendingBalance,
    ledgerBalance: shop.ledgerBalance,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Get balance summary for a shop.
 * Shop owners see their own; admins can view any.
 */
export async function getShopBalance(
  shopId: string,
  requesterId: string,
  requesterType: string
) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      id: true,
      name: true,
      ownerUserId: true,
      pendingBalance: true,
      ledgerBalance: true,
      debtAmount: true,
      lastSettlementAt: true,
    },
  });

  if (!shop) throw ApiError.notFound('Shop not found');
  if (requesterType !== 'ADMIN' && shop.ownerUserId !== requesterId) {
    throw ApiError.forbidden('Not your shop');
  }

  return {
    shopId: shop.id,
    shopName: shop.name,
    pendingBalance: shop.pendingBalance,
    ledgerBalance: shop.ledgerBalance,
    debtAmount: shop.debtAmount,
    lastSettlementAt: shop.lastSettlementAt,
  };
}
