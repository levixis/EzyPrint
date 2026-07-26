import React, { useState, useEffect, useCallback } from 'react';
import { RazorpayRefund } from '../../types';
import { useAppContext } from '../../contexts/AppContext';

interface RefundHistoryTrackerProps {
  orderId: string;
}

const debugLog = (...args: unknown[]) => {
  void args;
};

export const RefundHistoryTracker: React.FC<RefundHistoryTrackerProps> = ({ orderId }) => {
  const { syncRefundHistory, addNotification } = useAppContext();
  const [refunds, setRefunds] = useState<RazorpayRefund[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  const fetchHistory = useCallback(async (showNotification = false) => {
    isSyncing ? null : setIsLoading(true);
    if (showNotification) setIsSyncing(true);

    try {
      const result = await syncRefundHistory(orderId);
      if (result.success) {
        setRefunds(result.refunds);
        if (showNotification) {
          addNotification({ message: 'Refund history synced with Razorpay.', type: 'success' });
        }
      } else {
        if (showNotification) {
          addNotification({ message: result.message || 'Failed to sync refund history.', type: 'error' });
        }
      }
    } catch (err) {
      debugLog(err);
      if (showNotification) {
        addNotification({ message: 'An error occurred while syncing.', type: 'error' });
      }
    } finally {
      setIsLoading(false);
      setIsSyncing(false);
    }
  }, [orderId, syncRefundHistory, addNotification, isSyncing]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  if (isLoading && refunds.length === 0) {
    return (
      <div className="flex justify-center items-center p-4">
        <div className="animate-pulse flex items-center gap-2 text-gray-400">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
          <span className="text-xs">Loading Live Refund Data...</span>
        </div>
      </div>
    );
  }

  if (refunds.length === 0 && !isLoading) {
    return (
      <div className="bg-gray-50 dark:bg-zinc-800/50 rounded-lg p-4 border border-gray-200 dark:border-zinc-700 text-center">
        <p className="text-xs text-gray-500 dark:text-gray-400">No refunds found on Razorpay for this order.</p>
        <button onClick={() => fetchHistory(true)} className="mt-2 text-xs text-brand-primary underline underline-offset-2 hover:text-brand-primary/80 transition-colors">
          Sync Live from Razorpay
        </button>
      </div>
    );
  }

  return (
    <div className="bg-gray-50 dark:bg-zinc-800 rounded-xl p-4 border border-gray-200 dark:border-zinc-700 relative overflow-hidden">
      <div className="flex items-center justify-between mb-4">
        <h5 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-brand-primary">
            <path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm1 4a1 1 0 1 0-2 0v5.5a.75.75 0 0 0 .22.53l3 3a1 1 0 0 0 1.41-1.41l-2.63-2.63V6Z" />
          </svg>
          Live Banking Timeline
        </h5>
        
        <button
          onClick={() => fetchHistory(true)}
          disabled={isSyncing}
          className={`flex items-center gap-1.5 text-[10px] uppercase font-bold tracking-wider px-2 py-1 rounded bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 shadow-sm transition-all
            ${isSyncing ? 'text-gray-400 cursor-not-allowed' : 'text-gray-600 dark:text-gray-300 hover:border-brand-primary hover:text-brand-primary active:scale-95'}`}
        >
          {isSyncing ? (
            <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3 h-3">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
          )}
          Sync Live
        </button>
      </div>

      <div className="space-y-4 border-l-2 border-gray-200 dark:border-zinc-700 pl-4 ml-2 relative">
        {refunds.map((refund) => {
          let statusColor = 'bg-gray-400';
          let borderColor = 'border-gray-200 dark:border-zinc-700';
          let textColor = 'text-gray-600 dark:text-gray-400';
          let icon = '⏳';

          if (refund.status === 'processed') {
            statusColor = 'bg-emerald-500 shadow-emerald-500/30';
            borderColor = 'border-emerald-200 dark:border-emerald-900/30';
            textColor = 'text-emerald-700 dark:text-emerald-400';
            icon = '✅';
          } else if (refund.status === 'failed') {
            statusColor = 'bg-red-500 shadow-red-500/30';
            borderColor = 'border-red-200 dark:border-red-900/30';
            textColor = 'text-red-700 dark:text-red-400';
            icon = '❌';
          } else if (refund.status === 'pending') {
            statusColor = 'bg-amber-500 shadow-amber-500/30';
            borderColor = 'border-amber-200 dark:border-amber-900/30';
            textColor = 'text-amber-700 dark:text-amber-400';
            icon = '⏳';
          }

          return (
            <div key={refund.id} className={`relative bg-white dark:bg-zinc-900 rounded-lg p-3 border ${borderColor} shadow-sm group`}>
              {/* Timeline Dot */}
              <div className={`absolute -left-[23px] top-4 w-2.5 h-2.5 rounded-full ring-4 ring-gray-50 dark:ring-zinc-800 shadow-sm ${statusColor}`}></div>
              
              <div className="flex justify-between items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-bold text-gray-900 dark:text-white uppercase tracking-wide">
                      {icon} {refund.status}
                    </span>
                    <span className="text-[10px] text-gray-400 bg-gray-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded font-mono truncate">
                      {refund.id}
                    </span>
                  </div>
                  
                  <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">
                    {new Date(refund.created_at * 1000).toLocaleString()}
                  </p>
                  
                  {refund.acquirer_data?.arn && (
                     <div className="mt-2 text-[10px]">
                       <span className="text-gray-400">ARN: </span>
                       <span className="font-mono text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-zinc-800 px-1 py-0.5 rounded">
                         {refund.acquirer_data.arn}
                       </span>
                     </div>
                  )}
                  {refund.notes?.reason && (
                    <div className="mt-1 flex gap-1 items-start text-[10px] italic text-gray-500 dark:text-gray-400">
                      <span className="mt-0.5">💬</span>
                      <span>{refund.notes.reason}</span>
                    </div>
                  )}
                </div>
                
                <div className="text-right flex-shrink-0">
                  <p className={`text-sm font-bold ${textColor}`}>
                    ₹{(refund.amount / 100).toFixed(2)}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
