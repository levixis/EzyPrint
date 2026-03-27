import React, { useState } from 'react';
import { DocumentOrder, OrderStatus } from '../../types';
import ShopOrderCard from './ShopOrderCard';

interface ShopOrderListProps {
  orders: DocumentOrder[]; // These are already filtered shop-relevant orders for the current shop
  onSelectOrder: (orderId: string) => void;
}

const HISTORY_PAGE_SIZE = 6;

const ShopOrderList: React.FC<ShopOrderListProps> = ({ orders, onSelectOrder }) => {
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE_SIZE);

  const processingOrders = orders.filter(o => [OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING].includes(o.status))
    .sort((a, b) => {
      // Premium orders first, then by upload time (FIFO)
      if (a.isPremiumOrder && !b.isPremiumOrder) return -1;
      if (!a.isPremiumOrder && b.isPremiumOrder) return 1;
      return new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime();
    });

  const readyForPickupOrders = orders.filter(o => o.status === OrderStatus.READY_FOR_PICKUP)
    .sort((a, b) => {
      if (a.isPremiumOrder && !b.isPremiumOrder) return -1;
      if (!a.isPremiumOrder && b.isPremiumOrder) return 1;
      return new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime();
    });

  const historicalOrders = orders.filter(o => [OrderStatus.COMPLETED, OrderStatus.CANCELLED].includes(o.status))
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

  const visibleHistoricalOrders = historicalOrders.slice(0, historyLimit);
  const hasMoreHistory = historicalOrders.length > historyLimit;

  if (orders.length === 0) {
    return <p className="text-gray-600 dark:text-gray-400 text-center py-6">The print queue is empty for shop actions.</p>;
  }

  return (
    <div className="space-y-10">
      {processingOrders.length > 0 && (
        <div>
          <h3 className="text-2xl font-semibold text-brand-primary mb-4 pb-2 border-b-2 border-brand-primary/30">Processing Orders</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {processingOrders.map(order => (
              <ShopOrderCard key={order.id} order={order} onSelectOrder={onSelectOrder} />
            ))}
          </div>
        </div>
      )}
      {readyForPickupOrders.length > 0 && (
        <div>
          <h3 className="text-2xl font-semibold text-status-success mb-4 pb-2 border-b-2 border-status-success/30">Ready for Pickup</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {readyForPickupOrders.map(order => (
              <ShopOrderCard key={order.id} order={order} onSelectOrder={onSelectOrder} />
            ))}
          </div>
        </div>
      )}
      {processingOrders.length === 0 && readyForPickupOrders.length === 0 && (
        <p className="text-gray-600 dark:text-gray-400 text-center py-6 text-lg">No active orders requiring attention.</p>
      )}
      {historicalOrders.length > 0 && (
        <div>
          <h3 className="text-xl font-semibold text-gray-500 dark:text-gray-400 mt-10 mb-4 pb-2 border-b border-gray-300 dark:border-zinc-600">Order History (Completed/Cancelled)</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {visibleHistoricalOrders.map(order => (
              <ShopOrderCard key={order.id} order={order} onSelectOrder={onSelectOrder} />
            ))}
          </div>
          {(hasMoreHistory || historyLimit > HISTORY_PAGE_SIZE) && (
            <div className="flex justify-center gap-3 mt-6">
              {hasMoreHistory && (
                <button
                  onClick={() => setHistoryLimit(prev => prev + HISTORY_PAGE_SIZE)}
                  className="px-5 py-2 text-sm font-medium text-brand-primary bg-brand-primary/10 hover:bg-brand-primary/20 rounded-lg transition-colors"
                >
                  Show More ({historicalOrders.length - historyLimit} remaining)
                </button>
              )}
              {historyLimit > HISTORY_PAGE_SIZE && (
                <button
                  onClick={() => setHistoryLimit(HISTORY_PAGE_SIZE)}
                  className="px-5 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg transition-colors"
                >
                  Show Less
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ShopOrderList;
