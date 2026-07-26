import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import type { LedgerEntryType, LedgerCounterparty, LedgerCreatedBy } from '@prisma/client';

/**
 * Ledger Service — financial tracking for shops.
 *
 * Every monetary event creates an immutable ledger entry.
 * Uses optimistic concurrency (financialVersion) on shop balance updates.
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
  const shop = await prisma.shop.findUnique({ where: { id: data.shopId } });
  if (!shop) throw ApiError.notFound('Shop not found');

  // Calculate balance deltas
  let pendingDelta = 0;

  switch (data.type) {
    case 'ORDER_EARNING':
      pendingDelta = data.amount;
      break;
    case 'REFUND_DEDUCTION':
    case 'MANUAL_PAYOUT_DEDUCTION':
    case 'CLAWBACK':
      pendingDelta = -data.amount;
      break;
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

  const [entry] = await prisma.$transaction([
    prisma.ledgerEntry.create({
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
    }),
    prisma.shop.update({
      where: {
        id: data.shopId,
        financialVersion: shop.financialVersion,
      },
      data: {
        pendingBalance: { increment: pendingDelta },
        financialVersion: { increment: 1 },
      },
    }),
  ]);

  return entry;
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
