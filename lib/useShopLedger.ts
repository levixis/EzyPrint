import { useCallback, useEffect, useRef, useState } from 'react';
import {
  subscribeToShopLedger,
  fetchBalanceSnapshot,
  reportSnapshotSeq,
  type BalanceSnapshot,
  type ConnectionState,
  type RealtimeEnvelope,
} from './realtime';

/**
 * Live shop balances and ledger activity.
 *
 * Everything this hook exposes is server-confirmed. There is deliberately no
 * way to write a balance into it optimistically: money on screen must reflect
 * what the ledger actually says, because a figure that appears and then
 * disappears reads to a shop owner as lost money. Optimistic behaviour belongs
 * to the shop's own order actions, which live elsewhere.
 */

export interface LedgerActivityItem {
  id: string;
  type: string;
  status: string;
  amount: number;
  description: string;
  orderId?: string;
  createdAt: string;
  availableAt?: string | null;
  /** Set briefly on arrival so the UI can highlight money landing live. */
  isNew?: boolean;
}

interface UseShopLedgerResult {
  balances: BalanceSnapshot | null;
  connection: ConnectionState;
  /** Ledger entries received live this session, newest first. */
  liveActivity: LedgerActivityItem[];
  isLoading: boolean;
  refresh: () => void;
}

const MAX_LIVE_ACTIVITY = 25;

export function useShopLedger(shopId: string | undefined): UseShopLedgerResult {
  const [balances, setBalances] = useState<BalanceSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [liveActivity, setLiveActivity] = useState<LedgerActivityItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Guards against a slow in-flight snapshot landing after a newer one.
  const resyncToken = useRef(0);

  const resync = useCallback(async () => {
    if (!shopId) return;
    const token = ++resyncToken.current;

    try {
      const snapshot = await fetchBalanceSnapshot(shopId);
      if (token !== resyncToken.current) return;
      setBalances(snapshot);
      // Realign the event sequence to what this snapshot reflects.
      reportSnapshotSeq(shopId, snapshot.seq);
    } catch (error) {
      console.error('[ledger] balance refresh failed:', error);
    } finally {
      if (token === resyncToken.current) setIsLoading(false);
    }
  }, [shopId]);

  useEffect(() => {
    if (!shopId) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    void resync();

    const unsubscribe = subscribeToShopLedger(shopId, {
      onBalances: (next, seq) => {
        // Merge rather than replace: a ledger event carries the three stored
        // balances but not `inProgress`, which is derived from live orders.
        setBalances(prev =>
          prev
            ? { ...prev, clearing: next.clearing, available: next.available, debt: next.debt, seq }
            : prev
        );
      },

      onLedgerEvent: (envelope: RealtimeEnvelope) => {
        const data = envelope.data as { entry?: LedgerActivityItem } | undefined;
        if (!data?.entry) return;
        const entry = { ...data.entry, isNew: true };

        setLiveActivity(prev => {
          if (prev.some(item => item.id === entry.id)) return prev;
          return [entry, ...prev].slice(0, MAX_LIVE_ACTIVITY);
        });

        // Drop the highlight after a moment so it marks arrival, not age.
        window.setTimeout(() => {
          setLiveActivity(prev =>
            prev.map(item => (item.id === entry.id ? { ...item, isNew: false } : item))
          );
        }, 6000);
      },

      onOrderUpdated: () => {
        // An order moving through fulfilment changes `inProgress`, which is
        // derived server-side, so take a fresh snapshot.
        void resync();
      },

      onPayoutUpdated: () => {
        void resync();
      },

      onResync: () => {
        void resync();
      },

      onConnectionChange: setConnection,
    });

    return unsubscribe;
  }, [shopId, resync]);

  /**
   * Safety net for the case where the real-time layer is unavailable — an
   * unconfigured Pusher key, a blocked WebSocket, a network that drops the
   * connection without firing a state change. Deliberately slow: when the
   * connection is healthy this almost never fires, which is the point of
   * replacing the old 30-second polls.
   */
  useEffect(() => {
    if (!shopId) return;
    const intervalMs = connection === 'connected' ? 5 * 60 * 1000 : 30 * 1000;
    const timer = window.setInterval(() => void resync(), intervalMs);
    return () => window.clearInterval(timer);
  }, [shopId, connection, resync]);

  return { balances, connection, liveActivity, isLoading, refresh: resync };
}
