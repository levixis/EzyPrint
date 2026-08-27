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
  // Nothing to deliver *with*. `deliver` returns 0 without touching the rows in
  // this case — no publish, and no failed attempt either — so selecting them
  // meant re-reading the same oldest hundred every ten seconds forever, making
  // no progress and never reaching the attempt cap. Production cannot get here
  // (`requireSecret` refuses to boot without Pusher credentials); a developer's
  // machine does it all day.
  if (!getPusher()) return 0;

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

      // Say something when a row gives up.
      //
      // The attempt cap is what stops a poison row being retried forever, but
      // crossing it was silent: `pruneOutbox` only deletes rows that were
      // published, so an exhausted event sat in the table undelivered and
      // unmentioned, and the shop owner's ledger simply missed it. Reported
      // once, on the attempt that exhausts the budget.
      const exhausted = await prisma.realtimeOutbox.count({
        where: { id: { in: batch.map(r => r.id) }, attempts: MAX_ATTEMPTS },
      });

      if (exhausted > 0) {
        console.error(
          `[realtime] ${exhausted} event(s) exhausted ${MAX_ATTEMPTS} delivery attempts ` +
          `and will not be retried: ${message}`
        );
      }
    }
  }

  return delivered;
}

/**
 * Remove events past the retention window — delivered or definitively not.
 *
 * The outbox is a delivery buffer, not an audit log — `ledger_entries` is the
 * financial record of truth.
 *
 * This deleted only *published* rows, which left the one population that can
 * never leave on its own: a row that exhausted `MAX_ATTEMPTS` is excluded from
 * `dispatchOutbox` by the same cap, so it was neither retried nor pruned. Every
 * ledger movement writes one of these, so a sustained Pusher outage left a
 * permanent row per money movement and nothing ever removed them.
 *
 * Exhausted rows are reported rather than quietly dropped: each one is a balance
 * event a shop's ledger view never received, and by the time it is pruned the
 * only remaining trace is this alert.
 */
export async function pruneOutbox(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const abandoned = await prisma.realtimeOutbox.findMany({
    where: { publishedAt: null, attempts: { gte: MAX_ATTEMPTS }, createdAt: { lt: cutoff } },
    select: { id: true, channel: true, event: true, lastError: true },
  });

  if (abandoned.length > 0) {
    console.error(
      `[realtime] dropping ${abandoned.length} event(s) that never delivered:`,
      abandoned.map((r) => `${r.channel}/${r.event} (${r.lastError ?? 'no error recorded'})`)
    );
    // Imported lazily: notify.service reads shops and users, and this module is
    // imported by the ledger write path — a static import would make that a
    // cycle. Fire-and-forget, because a pruning sweep must not fail on a
    // notification.
    void import('./notify.service')
      .then((notify) =>
        notify.notifyAdmins(
          `${abandoned.length} real-time balance event(s) were never delivered after ` +
          `${MAX_ATTEMPTS} attempts and have now been pruned. Affected shops may show a ` +
          `stale ledger until they refresh.`,
          'error'
        )
      )
      .catch((error) => console.error('[realtime] could not report abandoned events:', error));
  }

  const result = await prisma.realtimeOutbox.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      OR: [
        { publishedAt: { not: null } },
        { publishedAt: null, attempts: { gte: MAX_ATTEMPTS } },
      ],
    },
  });
  return result.count;
}
