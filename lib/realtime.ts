import Pusher, { type Channel } from 'pusher-js';
import * as api from './api';

/**
 * Real-time shop ledger transport.
 *
 * Every event about money arrives here from a private, per-shop Pusher channel
 * and is applied only after the sequence check below. Nothing in this file ever
 * invents a balance — figures come from the server or are refetched.
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
  seq: number;
  emittedAt: string;
  type: RealtimeEventType;
  data: T;
}

/** The four stages money passes through, all in paise. */
export interface BalanceSnapshot {
  shopId: string;
  shopName?: string;
  /** Paid for but not yet fulfilled. */
  inProgress: number;
  /** Earned, inside the settlement window. */
  clearing: number;
  /** Withdrawable now. */
  available: number;
  /** Owed back, offset against future earnings. */
  debt: number;
  nextSettlementAt: string | null;
  lastSettlementAt: string | null;
  seq: number;
}

export interface LedgerEventBalances {
  clearing: number;
  available: number;
  debt: number;
}

const PUSHER_KEY = import.meta.env.VITE_PUSHER_KEY as string | undefined;
const PUSHER_CLUSTER = (import.meta.env.VITE_PUSHER_CLUSTER as string | undefined) || 'ap2';

let client: Pusher | null = null;

/**
 * Shared Pusher client.
 *
 * Uses a custom `authorizer` rather than Pusher's built-in `authEndpoint` so
 * channel authorization goes through the app's own fetch wrapper. That is what
 * gives it the Bearer header and, more importantly, the 401 → refresh → retry
 * logic — with `authEndpoint`, subscriptions would start failing silently the
 * moment an access token expired.
 */
function getClient(): Pusher | null {
  if (!PUSHER_KEY) return null;

  if (!client) {
    client = new Pusher(PUSHER_KEY, {
      cluster: PUSHER_CLUSTER,
      authorizer: (channel) => ({
        authorize: (socketId, callback) => {
          api
            .post<{ auth: string; channel_data?: string }>('/realtime/auth', {
              socket_id: socketId,
              channel_name: channel.name,
            })
            .then((data) => callback(null, data))
            .catch((error) => callback(error as Error, null));
        },
      }),
    });
  }

  return client;
}

export function disconnectRealtime(): void {
  client?.disconnect();
  client = null;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface ShopLedgerHandlers {
  /** A server-confirmed balance change. Never called with a stale sequence. */
  onBalances: (balances: LedgerEventBalances, seq: number) => void;
  /** A ledger entry was created or settled — for the activity feed. */
  onLedgerEvent: (envelope: RealtimeEnvelope) => void;
  /** Server-confirmed order state, used to reconcile optimistic UI. */
  onOrderUpdated: (orderId: string, status: string) => void;
  onPayoutUpdated: (payoutId: string, status: string) => void;
  /**
   * Called when the client cannot trust its local figures — on connect, on
   * reconnect, or after a gap in the sequence. The caller should refetch the
   * authoritative snapshot.
   */
  onResync: () => void;
  onConnectionChange: (state: ConnectionState) => void;
}

/**
 * Subscribe to a shop's private ledger channel.
 *
 * Returns an unsubscribe function.
 */
export function subscribeToShopLedger(
  shopId: string,
  handlers: ShopLedgerHandlers
): () => void {
  const pusher = getClient();
  if (!pusher) {
    // Without a configured key there is no real-time layer; callers keep their
    // polling fallback and the dashboard still works.
    handlers.onConnectionChange('disconnected');
    return () => {};
  }

  const channelName = `private-shop-${shopId}`;
  let channel: Channel | null = null;

  // Highest sequence applied so far. Pusher guarantees neither ordering nor
  // exactly-once delivery, so this is what keeps a stale or duplicated event
  // from overwriting a newer balance.
  let lastAppliedSeq = -1;

  const handleConnectionState = () => {
    const state = pusher.connection.state;
    if (state === 'connected') {
      handlers.onConnectionChange('connected');
      // Anything that happened while disconnected was missed.
      handlers.onResync();
    } else if (state === 'connecting' || state === 'initialized') {
      handlers.onConnectionChange('connecting');
    } else {
      handlers.onConnectionChange('disconnected');
    }
  };

  pusher.connection.bind('state_change', handleConnectionState);
  handleConnectionState();

  channel = pusher.subscribe(channelName);

  const applyBalances = (envelope: RealtimeEnvelope) => {
    const data = envelope.data as { balances?: LedgerEventBalances } | undefined;
    if (!data?.balances) return;

    if (envelope.seq <= lastAppliedSeq) {
      // Already applied, or arrived out of order behind a newer event.
      return;
    }

    if (lastAppliedSeq >= 0 && envelope.seq > lastAppliedSeq + 1) {
      // A balance change went missing. Rather than applying this one on top of
      // an unknown intermediate state, refetch the authoritative snapshot.
      lastAppliedSeq = envelope.seq;
      handlers.onResync();
      return;
    }

    lastAppliedSeq = envelope.seq;
    handlers.onBalances(data.balances, envelope.seq);
  };

  const onLedger = (envelope: RealtimeEnvelope) => {
    if (envelope.v !== REALTIME_ENVELOPE_VERSION) return;
    applyBalances(envelope);
    handlers.onLedgerEvent(envelope);
  };

  channel.bind('ledger.credited', onLedger);
  channel.bind('ledger.debited', onLedger);
  channel.bind('ledger.settled', onLedger);

  const onOrder = (envelope: RealtimeEnvelope) => {
    const data = envelope.data as { orderId?: string; status?: string } | undefined;
    if (data?.orderId && data.status) {
      handlers.onOrderUpdated(data.orderId, data.status);
    }
  };
  channel.bind('order.updated', onOrder);

  const onPayout = (envelope: RealtimeEnvelope) => {
    const data = envelope.data as { payoutId?: string; status?: string } | undefined;
    if (data?.payoutId && data.status) {
      handlers.onPayoutUpdated(data.payoutId, data.status);
    }
    applyBalances(envelope);
  };
  channel.bind('payout.updated', onPayout);

  /** Let the caller reset the sequence baseline after refetching a snapshot. */
  const onSnapshotApplied = (seq: number) => {
    lastAppliedSeq = seq;
  };
  seqResetters.set(shopId, onSnapshotApplied);

  return () => {
    channel?.unbind_all();
    pusher.unsubscribe(channelName);
    pusher.connection.unbind('state_change', handleConnectionState);
    seqResetters.delete(shopId);
  };
}

/**
 * After a snapshot refetch, the caller reports the sequence it just applied so
 * subsequent events are compared against it rather than a stale baseline.
 */
const seqResetters = new Map<string, (seq: number) => void>();

export function reportSnapshotSeq(shopId: string, seq: number): void {
  seqResetters.get(shopId)?.(seq);
}

/** Fetch the authoritative balance snapshot. */
export function fetchBalanceSnapshot(shopId: string): Promise<BalanceSnapshot> {
  return api.get<BalanceSnapshot>(`/realtime/balance/${shopId}`);
}
