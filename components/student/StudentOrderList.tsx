import React, { useState } from 'react';
import { DocumentOrder, OrderStatus, UserType } from '../../types';
import StudentOrderCard from './StudentOrderCard';
import PaymentModal from './PaymentModal'; 
import { useAppContext } from '../../contexts/AppContext';

interface StudentOrderListProps {
  orders: DocumentOrder[];
}

const StudentOrderList: React.FC<StudentOrderListProps> = ({ orders }) => {
  const [paymentOrder, setPaymentOrder] = useState<DocumentOrder | null>(null);
  const { updateOrderStatus } = useAppContext();

  const handlePayNow = (order: DocumentOrder) => {
    setPaymentOrder(order);
  };

  const handlePaymentSuccess = (_orderId: string) => {
    // The Cloud Function (verifyPayment) already updates the order to PENDING_APPROVAL in Firestore.
    // The onSnapshot listener will propagate the change. No need to call updateOrderStatus here,
    // which would cause duplicate notifications.
    setPaymentOrder(null);
  };

  const handlePaymentFailure = (orderId: string) => {
    updateOrderStatus(orderId, OrderStatus.PAYMENT_FAILED, { 
      paymentAttemptedAt: new Date().toISOString(),
      actingUserType: UserType.STUDENT
    });
    setPaymentOrder(null);
  };

  const handleCancelOrder = (order: DocumentOrder) => {
    if (window.confirm("Are you sure you want to cancel this order? It will be hidden from your list.")) {
      updateOrderStatus(order.id, OrderStatus.CANCELLED, {
        actingUserType: UserType.STUDENT
      });
    }
  };

  const visibleOrders = orders.filter(o => o.status !== OrderStatus.CANCELLED);

  if (visibleOrders.length === 0) {
    return <p className="text-brand-lightText text-center py-6">No orders found.</p>;
  }

  const sortedOrders = [...visibleOrders].sort((a, b) => {
    if (a.status === OrderStatus.PENDING_PAYMENT && b.status !== OrderStatus.PENDING_PAYMENT) return -1;
    if (a.status !== OrderStatus.PENDING_PAYMENT && b.status === OrderStatus.PENDING_PAYMENT) return 1;
    if (a.status === OrderStatus.PAYMENT_FAILED && b.status !== OrderStatus.PAYMENT_FAILED) return -1;
    if (a.status !== OrderStatus.PAYMENT_FAILED && b.status === OrderStatus.PAYMENT_FAILED) return 1;
    return new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
  });

  return (
    <div className="space-y-6">
      {sortedOrders.map(order => (
        <StudentOrderCard key={order.id} order={order} onPayNow={handlePayNow} onCancelOrder={handleCancelOrder} />
      ))}
      {paymentOrder && (
        <PaymentModal
          isOpen={!!paymentOrder}
          onClose={() => setPaymentOrder(null)}
          order={paymentOrder}
          onPaymentSuccess={handlePaymentSuccess}
          onPaymentFailure={handlePaymentFailure}
        />
      )}
    </div>
  );
};

export default StudentOrderList;