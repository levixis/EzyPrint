import React from 'react';
import { DocumentOrder, OrderStatus } from '../../types';
import ShopOrderCard from './ShopOrderCard';

interface ShopOrderListProps {
  orders: DocumentOrder[]; // These are already filtered shop-relevant orders for the current shop
  onSelectOrder: (orderId: string) => void;
}

const ShopOrderList: React.FC<ShopOrderListProps> = ({ orders, onSelectOrder }) => {
  
  const processingOrders = orders.filter(o => [OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING].includes(o.status))
    .sort((a,b) => new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime());
  
  const readyForPickupOrders = orders.filter(o => o.status === OrderStatus.READY_FOR_PICKUP)
    .sort((a,b) => new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime());

  const historicalOrders = orders.filter(o => [OrderStatus.COMPLETED, OrderStatus.CANCELLED].includes(o.status))
    .sort((a,b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()).slice(0, 10); // Show recent 10

  if (orders.length === 0) {
    return <p className="text-brand-lightText text-center py-6">The print queue is empty for shop actions.</p>;
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
        <p className="text-brand-lightText text-center py-6 text-lg">No active orders requiring attention.</p>
      )}
      {historicalOrders.length > 0 && (
         <div>
          <h3 className="text-xl font-semibold text-brand-muted mt-10 mb-4 pb-2 border-b border-brand-muted/30">Recent History (Completed/Cancelled)</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 opacity-80">
            {historicalOrders.map(order => (
              <ShopOrderCard key={order.id} order={order} onSelectOrder={onSelectOrder} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ShopOrderList;
