import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { enqueueShopEvent, publishQueued, type RealtimeEventType } from './realtime.service';
import type { LedgerEntryType, LedgerCounterparty, LedgerCreatedBy, LedgerEntryStatus } from '@prisma/client';

/**
 * Ledger Service — financial tracking for shops.
 *
 * Every monetary event creates an immutable, append-only ledger entry. All
 * amounts are paise.
 *
 * Balance updates use optimistic concurrency on `Shop.financialVersion`: the
 * shop row is read inside an interactive transaction and written with the
 * version in the WHERE clause, so two concurrent writers cannot both apply
 * their delta to the same starting balance. `financialVersion` doubles as the
 * per-shop sequence number for real-time events.
 */

/** Which ledger types add to the balance rather than draw from it. */
const CREDIT_TYPES: ReadonlySet<LedgerEntryType> = new Set<LedgerEntryType>([
  'ORDER_EARNING',
  'PAYOUT_CANCEL_REFUND',
  'PAYOUT_REJECT_REFUND',
  'ADJUSTMENT',
]);

/**
 * Which balance a movement primarily touches.
 *
 * Earnings land in CLEARING and mature into AVAILABLE at settlement. Payouts
 * draw from AVAILABLE, because money still inside the settlement window is not
 * withdrawable yet — that distinction is the whole point of the two buckets.
 */
type Bucket = 'CLEARING' | 'AVAILABLE';

const BUCKET_FOR_TYPE: Record<LedgerEntryType, Bucket> = {
  ORDER_EARNING: 'CLEARING',
  REFUND_DEDUCTION: 'CLEARING',
  CLAWBACK: 'CLEARING',
  ADJUSTMENT: 'CLEARING',
  PAYOUT: 'AVAILABLE',
  MANUAL_PAYOUT_DEDUCTION: 'AVAILABLE',
  PAYOUT_CANCEL_REFUND: 'AVAILABLE',
  PAYOUT_REJECT_REFUND: 'AVAILABLE',
};

interface BalanceMovement {
  clearing: number;
  available: number;
  debt: number;
}

/**
 * Work out how a movement redistributes across the shop's balances.
 *
 * Credits pay down outstanding debt before adding to a balance. Debits drain
 * their own bucket first, spill into the other, and only then accrue debt — so
 * a refund on a shop that has already been paid out still succeeds, and the
 * shortfall stays visible as debt rather than as a negative balance.
 */
export function computeBalanceMovement(
  type: LedgerEntryType,
  amount: number,
  shop: { pendingBalance: number; ledgerBalance: number; debtAmount: number }
): BalanceMovement {
  const bucket = BUCKET_FOR_TYPE[type];

  if (CREDIT_TYPES.has(type)) {
    const towardsDebt = Math.min(amount, Math.max(0, shop.debtAmount));
    const remainder = amount - towardsDebt;
    return {
      clearing: bucket === 'CLEARING' ? remainder : 0,
      available: bucket === 'AVAILABLE' ? remainder : 0,
      // `|| 0` normalises negative zero, which is a distinct value in JS and
      // leaks into equality checks and serialized event payloads.
      debt: -towardsDebt || 0,
    };
  }

  let remaining = amount;
  const movement: BalanceMovement = { clearing: 0, available: 0, debt: 0 };
  const drainOrder: Bucket[] = bucket === 'AVAILABLE'
    ? ['AVAILABLE', 'CLEARING']
    : ['CLEARING', 'AVAILABLE'];

  for (const target of drainOrder) {
    const balance = target === 'AVAILABLE' ? shop.ledgerBalance : shop.pendingBalance;
    const take = Math.min(remaining, Math.max(0, balance));
    if (target === 'AVAILABLE') movement.available -= take;
    else movement.clearing -= take;
    remaining -= take;
  }

  movement.debt = remaining;
  return movement;
}

/** Real-time event type implied by a ledger movement. */
function eventTypeFor(type: LedgerEntryType): RealtimeEventType {
  return CREDIT_TYPES.has(type) ? 'ledger.credited' : 'ledger.debited';
}

export interface CreateLedgerEntryInput {
  shopId: string;
  type: LedgerEntryType;
  /** Paise. Always positive — direction comes from `type`. */
  amount: number;
  description: string;
  counterparty: LedgerCounterparty;
  createdBy?: LedgerCreatedBy;
  orderId?: string;
  /** Deterministic dedup key. The unique constraint on it is what makes
   *  double-crediting impossible under concurrent delivery. */
  eventId?: string;
  /** When the entry becomes withdrawable. Stamped at write time. */
  availableAt?: Date | null;
  status?: LedgerEntryStatus;
  /**
   * Allow the balance to go negative, carrying the shortfall into
   * `Shop.debtAmount`. Used for refunds, which must succeed even when a shop
   * has already been paid out — the money is owed regardless.
   */
  allowDebt?: boolean;
}

/**
 * Create a ledger entry and move the shop's balance atomically.
 *
 * Pass `txClient` to join a caller's transaction; otherwise one is opened here.
 * When joining a transaction the caller owns publishing the returned outbox ids
 * after commit.
 */
export async function createLedgerEntry(
  data: CreateLedgerEntryInput,
  txClient?: any,
  /**
   * Collects outbox ids when joining a caller's transaction. The caller passes
   * these to `publishQueued` after committing, so the shop sees the change
   * immediately rather than waiting for the dispatcher sweep.
   */
  outboxSink?: string[]
) {
  const outboxIds: string[] = outboxSink ?? [];

  const execute = async (tx: any) => {
    const shop = await tx.shop.findUnique({ where: { id: data.shopId } });
    if (!shop) throw ApiError.notFound('Shop not found');

    if (!Number.isInteger(data.amount) || data.amount < 0) {
      throw ApiError.badRequest('Ledger amount must be a non-negative whole number of paise');
    }

    // Deterministic dedup: if this event was already recorded, do nothing
    // rather than moving the balance a second time.
    if (data.eventId) {
      const existing = await tx.ledgerEntry.findUnique({ where: { eventId: data.eventId } });
      if (existing) return existing;
    }

    const movement = computeBalanceMovement(data.type, data.amount, shop);

    if (movement.debt > 0 && !data.allowDebt) {
      throw ApiError.badRequest('Insufficient balance');
    }

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
        status: data.status ?? 'PENDING',
        availableAt: data.availableAt ?? null,
        settledAt: (data.status ?? 'PENDING') === 'SETTLED' ? new Date() : null,
      },
    });

    // Compare-and-swap on financialVersion. A concurrent writer that read the
    // same version loses here and its whole transaction rolls back, taking the
    // ledger row with it. The `gte` guards additionally stop a balance being
    // driven negative if anything slipped past the movement calculation.
    const updated = await tx.shop.updateMany({
      where: {
        id: data.shopId,
        financialVersion: shop.financialVersion,
        ...(movement.clearing < 0 ? { pendingBalance: { gte: Math.abs(movement.clearing) } } : {}),
        ...(movement.available < 0 ? { ledgerBalance: { gte: Math.abs(movement.available) } } : {}),
      },
      data: {
        pendingBalance: { increment: movement.clearing },
        ledgerBalance: { increment: movement.available },
        debtAmount: { increment: movement.debt },
        financialVersion: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      throw ApiError.conflict('Concurrent balance update detected. Please retry the operation.');
    }

    const seq = shop.financialVersion + 1;

    const outboxId = await enqueueShopEvent(tx, {
      shopId: data.shopId,
      type: eventTypeFor(data.type),
      seq,
      data: {
        entry: {
          id: entry.id,
          type: entry.type,
          status: entry.status,
          amount: entry.amount,
          description: entry.description,
          orderId: entry.orderId,
          createdAt: entry.createdAt,
          availableAt: entry.availableAt,
        },
        balances: {
          clearing: shop.pendingBalance + movement.clearing,
          available: shop.ledgerBalance + movement.available,
          debt: shop.debtAmount + movement.debt,
        },
      },
    });
    outboxIds.push(outboxId);

    return entry;
  };

  const entry = txClient ? await execute(txClient) : await prisma.$transaction(execute);

  // Only publish here when we owned the transaction. A caller that passed its
  // own tx may still roll back after we return.
  if (!txClient) {
    await publishQueued(outboxIds);
  }

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

/**
 * Balance summary for a shop, in the four stages the dashboard shows.
 *
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
      financialVersion: true,
    },
  });

  if (!shop) throw ApiError.notFound('Shop not found');
  if (requesterType !== 'ADMIN' && shop.ownerUserId !== requesterId) {
    throw ApiError.forbidden('Not your shop');
  }

  return buildBalanceSnapshot(shop);
}

export interface BalanceSnapshot {
  shopId: string;
  shopName?: string;
  /** Paid for but not yet fulfilled — the shop's expected earnings. */
  inProgress: number;
  /** Earned, inside the settlement window. */
  clearing: number;
  /** Withdrawable now. */
  available: number;
  /** Owed back to the platform, offset against future earnings. */
  debt: number;
  /** Earliest moment any clearing money becomes available. */
  nextSettlementAt: string | null;
  lastSettlementAt: string | null;
  seq: number;
}

/**
 * Assemble the four-stage balance view.
 *
 * `inProgress` is derived from orders rather than stored, because money for an
 * unfulfilled order is not the shop's yet — it just needs to be visible so the
 * owner can see what is coming.
 */
export async function buildBalanceSnapshot(shop: {
  id: string;
  name?: string;
  pendingBalance: number;
  ledgerBalance: number;
  debtAmount: number;
  lastSettlementAt: Date | null;
  financialVersion: number;
}): Promise<BalanceSnapshot> {
  const [inProgressAgg, nextSettlement] = await Promise.all([
    prisma.order.aggregate({
      where: {
        shopId: shop.id,
        status: { in: ['PENDING_APPROVAL', 'PRINTING', 'READY_FOR_PICKUP'] },
      },
      _sum: { pageCost: true },
    }),
    prisma.ledgerEntry.findFirst({
      where: { shopId: shop.id, status: 'PENDING', availableAt: { not: null } },
      orderBy: { availableAt: 'asc' },
      select: { availableAt: true },
    }),
  ]);

  return {
    shopId: shop.id,
    shopName: shop.name,
    inProgress: inProgressAgg._sum.pageCost ?? 0,
    clearing: shop.pendingBalance,
    available: shop.ledgerBalance,
    debt: shop.debtAmount,
    nextSettlementAt: nextSettlement?.availableAt?.toISOString() ?? null,
    lastSettlementAt: shop.lastSettlementAt?.toISOString() ?? null,
    seq: shop.financialVersion,
  };
}
