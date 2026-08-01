import Pusher from 'pusher';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { env } from '../config/env';

/**
 * Real-time delivery for shop financial events.
 *
 * Events are written to `realtime_outbox` INSIDE the transaction that performs
 * the money movement they describe. That is the only placement that makes the
 * two atomic: publishing from the controller after the fact can announce a
 * transaction that later rolled back, and can silently drop an event if the
 * process dies after commit.
 *
 * Publishing itself happens after commit — never inside the transaction —
 * because a Pusher HTTP round trip would hold one of a very small number of
 * Neon pool connections open for its duration. The request path publishes
 * immediately for latency, and a background dispatcher sweeps anything still
 * unpublished, so delivery is at-least-once. Duplicates are harmless: the
 * client discards any event whose `seq` it has already applied.
 */

export const REALTIME_ENVELOPE_VERSION = 1;

export type RealtimeEventType =
  | 'ledger.credited'
  | 'ledger.settled'
  | 'ledger.debited'
  | 'balance.snapshot'
  | 'payout.updated'
  | 'order.updated';

export interface RealtimeEnvelope<T = unknown> {
  v: number;
  /**
   * Shop.financialVersion at the time of the write.
   *
   * Pusher does not guarantee ordering, and applying a stale balance would show
   * a shop owner the wrong number. Every balance-affecting write increments
   * financialVersion under the existing compare-and-swap, so this is a genuine
   * monotonic sequence per shop. Clients drop anything they have already seen
   * and refetch once when they spot a gap.
   */
  seq: number;
  emittedAt: string;
  type: RealtimeEventType;
  data: T;
}

/** Channel carrying a single shop's financial and order events. */
export function shopChannel(shopId: string): string {
  return `private-shop-${shopId}`;
}

/** Extract the shop id from a channel name, or null if it is not a shop channel. */
export function shopIdFromChannel(channel: string): string | null {
  const match = /^private-shop-(.+)$/.exec(channel);
  return match?.[1] ?? null;
}

let pusherClient: Pusher | null = null;

function getPusher(): Pusher | null {
  if (!env.PUSHER_APP_ID || !env.PUSHER_KEY || !env.PUSHER_SECRET) {
    return null;
  }
  if (!pusherClient) {
    pusherClient = new Pusher({
      appId: env.PUSHER_APP_ID,
      key: env.PUSHER_KEY,
      secret: env.PUSHER_SECRET,
      cluster: env.PUSHER_CLUSTER,
      useTLS: true,
    });
  }
  return pusherClient;
}

/** Authorize a client's subscription to a private channel. */
export function authorizeChannel(socketId: string, channel: string) {
  const pusher = getPusher();
  if (!pusher) {
    throw new Error('Pusher is not configured');
  }
  return pusher.authorizeChannel(socketId, channel);
}

/**
 * Queue an event inside the caller's transaction.
 *
 * `tx` must be the transaction client doing the money movement — passing the
 * plain prisma client here would defeat the point.
 */
export async function enqueueShopEvent(
  tx: Prisma.TransactionClient,
  params: {
    shopId: string;
    type: RealtimeEventType;
    seq: number;
    data: unknown;
  }
): Promise<string> {
  const envelope: RealtimeEnvelope = {
    v: REALTIME_ENVELOPE_VERSION,
    seq: params.seq,
    emittedAt: new Date().toISOString(),
    type: params.type,
    data: params.data,
  };

  const row = await tx.realtimeOutbox.create({
    data: {
      channel: shopChannel(params.shopId),
      event: params.type,
      seq: params.seq,
      payload: envelope as unknown as Prisma.InputJsonValue,
    },
  });

  return row.id;
}

/**
 * Publish specific outbox rows, best-effort.
 *
 * Call after the transaction commits. Failures are swallowed deliberately: the
 * money movement already succeeded, and the dispatcher will retry. Throwing
 * here would turn a delivery hiccup into a failed API request.
 */
export async function publishQueued(outboxIds: string[]): Promise<void> {
  if (outboxIds.length === 0) return;
  try {
    const rows = await prisma.realtimeOutbox.findMany({
      where: { id: { in: outboxIds }, publishedAt: null },
    });
    await deliver(rows);
  } catch (error) {
    console.error('[realtime] immediate publish failed, dispatcher will retry:', error);
  }
}

/** Maximum delivery attempts before a row is left for manual inspection. */
const MAX_ATTEMPTS = 10;

/**
 * Drain unpublished outbox rows. Runs on an interval and after process restart,
 * which is what makes delivery survive a crash between commit and publish.
 */
export async function dispatchOutbox(limit = 100): Promise<number> {
  const rows = await prisma.realtimeOutbox.findMany({
    where: { publishedAt: null, attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  if (rows.length === 0) return 0;
  return deliver(rows);
}

type OutboxRow = {
  id: string;
  channel: string;
  event: string;
  payload: unknown;
};

async function deliver(rows: OutboxRow[]): Promise<number> {
  const pusher = getPusher();
  if (!pusher || rows.length === 0) return 0;

  let delivered = 0;

  // Pusher accepts up to 10 events per batch call.
  for (let i = 0; i < rows.length; i += 10) {
    const batch = rows.slice(i, i + 10);
    try {
      await pusher.triggerBatch(
        batch.map(row => ({
          channel: row.channel,
          name: row.event,
          data: row.payload as object,
        }))
      );
      await prisma.realtimeOutbox.updateMany({
        where: { id: { in: batch.map(r => r.id) } },
        data: { publishedAt: new Date() },
      });
      delivered += batch.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await prisma.realtimeOutbox.updateMany({
        where: { id: { in: batch.map(r => r.id) } },
        data: { attempts: { increment: 1 }, lastError: message },
      });
      console.error('[realtime] batch delivery failed:', message);
    }
  }

  return delivered;
}

/**
 * Remove delivered events older than the retention window.
 *
 * The outbox is a delivery buffer, not an audit log — `ledger_entries` is the
 * financial record of truth.
 */
export async function pruneOutbox(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await prisma.realtimeOutbox.deleteMany({
    where: { publishedAt: { not: null, lt: cutoff } },
  });
  return result.count;
}
