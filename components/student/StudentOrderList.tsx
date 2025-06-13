import React, { useState } from 'react';
import { DocumentOrder, OrderStatus, UserType } from '../../types';
import StudentOrderCard from './StudentOrderCard';
import PaymentModal from './PaymentModal'; 
import { useAppContext } from '../../contexts/AppContext';

interface StudentOrderListProps {
  orders: DocumentOrder[];
}

const StudentOrderList: React.FC<StudentOrderListProps> = ({ orders }) => {
  const { updateOrderStatus } = useAppContext();
  const [paymentOrder, setPaymentOrder] = useState<DocumentOrder | null>(null);

  const handlePayNow = (order: DocumentOrder) => {
    setPaymentOrder(order);
  };

  const handlePaymentSuccess = (orderId: string) => { // Removed razorpayOrderId from signature
    updateOrderStatus(orderId, OrderStatus.PENDING_APPROVAL, { 
      paymentAttemptedAt: new Date().toISOString(),
      // razorpayOrderId removed
      actingUserType: UserType.STUDENT 
    });
    setPaymentOrder(null);
  };

  const handlePaymentFailure = (orderId: string) => {
    updateOrderStatus(orderId, OrderStatus.PAYMENT_FAILED, { 
      paymentAttemptedAt: new Date().toISOString(),
      actingUserType: UserType.STUDENT
    });
    setPaymentOrder(null);
  };

  if (orders.length === 0) {
    return <p className="text-brand-lightText text-center py-6">No orders found.</p>;
  }

  const sortedOrders = [...orders].sort((a, b) => {
    if (a.status === OrderStatus.PENDING_PAYMENT && b.status !== OrderStatus.PENDING_PAYMENT) return -1;
    if (a.status !== OrderStatus.PENDING_PAYMENT && b.status === OrderStatus.PENDING_PAYMENT) return 1;
    if (a.status === OrderStatus.PAYMENT_FAILED && b.status !== OrderStatus.PAYMENT_FAILED) return -1;
    if (a.status !== OrderStatus.PAYMENT_FAILED && b.status === OrderStatus.PAYMENT_FAILED) return 1;
    return new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
  });

  return (
    <div className="space-y-6">
      {sortedOrders.map(order => (
        <StudentOrderCard key={order.id} order={order} onPayNow={handlePayNow} />
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