import React, { useState, useCallback, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { DocumentOrder, OrderStatus, UserType } from '../../types';
import StudentOrderCard from './StudentOrderCard';
import { useAppContext } from '../../contexts/AppContext';
import { getOrderDisplayName } from '../../utils/orderHelpers';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../../firebase';
import { Spinner } from '../common/Spinner';

const RAZORPAY_KEY_ID = import.meta.env.VITE_RAZORPAY_KEY_ID;
const functions = getFunctions(app, 'asia-south1');

declare global {
    interface Window {
        Razorpay: new (opts: Record<string, unknown>) => { on: (event: string, cb: () => void) => void; open: () => void };
    }
}

interface StudentOrderListProps {
  orders: DocumentOrder[];
}

const StudentOrderList: React.FC<StudentOrderListProps> = ({ orders }) => {
  const [optimisticStatuses, setOptimisticStatuses] = useState<Record<string, OrderStatus>>({});
  const [processingOrderId, setProcessingOrderId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [showOverlay, setShowOverlay] = useState(false);
  const { updateOrderStatus, currentUser } = useAppContext();

  // Clear optimistic statuses once Firestore catches up with the real status
  useEffect(() => {
    setOptimisticStatuses(prev => {
      const updated = { ...prev };
      let changed = false;
      for (const orderId of Object.keys(updated)) {
        const realOrder = orders.find(o => o.id === orderId);
        // If the real order already has this status (or has moved past it), remove the override
        if (realOrder && realOrder.status === updated[orderId]) {
          delete updated[orderId];
          changed = true;
        }
      }
      return changed ? updated : prev;
    });
  }, [orders]);

  const handlePayNow = useCallback(async (order: DocumentOrder) => {
    if (processingOrderId) return;
    setProcessingOrderId(order.id);

    // SAFETY: If this is a retry (PAYMENT_FAILED), check if the previous payment
    // was actually captured by Razorpay before creating a new payment.
    if (order.status === OrderStatus.PAYMENT_FAILED && order.razorpayOrderId) {
      setStatusMessage('Checking previous payment...');
      try {
        const checkPaymentFn = httpsCallable(functions, 'checkPaymentStatus');
        const checkResult = await checkPaymentFn({ orderId: order.id });
        const checkData = checkResult.data as { paid: boolean; recovered?: boolean; message: string };

        if (checkData.paid && checkData.recovered) {
          // Payment was already captured! Order has been recovered.
          alert('Good news! Your previous payment was successful. The order has been updated.');
          setProcessingOrderId(null);
          setStatusMessage('');
          return;
        }
      } catch (checkErr) {
        console.warn('Payment status check failed, proceeding with new payment:', checkErr);
        // Continue with new payment if check fails
      }
    }

    setStatusMessage('Creating order...');

    try {
      const createOrderFn = httpsCallable(functions, 'createOrder');
      const result = await createOrderFn({ orderId: order.id });
      const data = result.data as {
        razorpayOrderId: string;
        amount: number;
        currency: string;
        verifiedPrice: { pageCost: number; baseFee: number; totalPrice: number };
      };

      const baseOptions: Record<string, unknown> = {
        key: RAZORPAY_KEY_ID,
        amount: data.amount,
        currency: data.currency,
        name: 'EzyPrint',
        description: `Order #${order.id.slice(-6)} - ${getOrderDisplayName(order)}`,
        order_id: data.razorpayOrderId,
        prefill: { name: currentUser?.name || '', email: currentUser?.email || '' },
        notes: { order_id: order.id, shop_id: order.shopId },
        theme: { color: '#EF4444' },
      };

      const onSuccess = (orderId: string) => {
        setOptimisticStatuses(prev => ({ ...prev, [orderId]: OrderStatus.PENDING_APPROVAL }));
        setProcessingOrderId(null);
        setShowOverlay(false);
        setStatusMessage('');
      };

      const onFailure = (orderId: string) => {
        updateOrderStatus(orderId, OrderStatus.PAYMENT_FAILED, {
          paymentAttemptedAt: new Date().toISOString(),
          actingUserType: UserType.STUDENT,
        });
        setProcessingOrderId(null);
        setShowOverlay(false);
        setStatusMessage('');
      };

      // Try native Razorpay on mobile (detects UPI apps), fallback to web SDK
      if (Capacitor.isNativePlatform()) {
        setProcessingOrderId(null);
        setStatusMessage('');

        let nativeCheckoutResult: unknown = null;
        let pluginAvailable = true;

        // Step 1: Try to open native checkout
        try {
          const { Checkout } = await import('capacitor-razorpay');
          nativeCheckoutResult = await Checkout.open(baseOptions as { key: string; amount: string });
        } catch (checkoutError: unknown) {
          console.error('Native Razorpay checkout error:', checkoutError);
          const errMsg = checkoutError instanceof Error ? checkoutError.message : String(checkoutError);

          // Plugin not available — fall back to web SDK
          if (errMsg.includes('not implemented') || errMsg.includes('not available') || errMsg.includes('plugin_not_installed')) {
            console.log('Native Razorpay unavailable, falling back to web SDK...');
            pluginAvailable = false;
            openWebRazorpay(baseOptions, order, onSuccess, onFailure);
          } else {
            // User cancelled or payment actually failed in native checkout
            console.log('Native checkout cancelled/failed:', errMsg);
            setProcessingOrderId(null);
            setShowOverlay(false);
            setStatusMessage('');
          }
        }

        // Step 2: If native checkout succeeded, verify the payment
        if (nativeCheckoutResult && pluginAvailable) {
          try {
            const result = nativeCheckoutResult as { response: unknown };
            console.log('Native Razorpay raw result:', JSON.stringify(result));

            const response = typeof result.response === 'string'
              ? JSON.parse(result.response)
              : result.response;

            console.log('Parsed Razorpay response:', JSON.stringify(response));

            const paymentId = response.razorpay_payment_id;
            const ordIdFromRzp = response.razorpay_order_id;
            const signature = response.razorpay_signature;

            if (!paymentId || !ordIdFromRzp || !signature) {
              console.error('Missing fields in Razorpay response:', { paymentId, ordIdFromRzp, signature });
              // Payment succeeded in Razorpay but response format is unexpected
              // DO NOT mark as failed — the money was already taken
              alert('Payment received but verification data is incomplete. Please contact support if your order is not updated.');
              setProcessingOrderId(null);
              setShowOverlay(false);
              setStatusMessage('');
              return;
            }

            setShowOverlay(true);
            setStatusMessage('Verifying payment...');
            const verifyPaymentFn = httpsCallable(functions, 'verifyPayment');
            await verifyPaymentFn({
              razorpay_order_id: ordIdFromRzp,
              razorpay_payment_id: paymentId,
              razorpay_signature: signature,
              orderId: order.id,
            });
            onSuccess(order.id);
          } catch (verifyError: unknown) {
            console.error('Payment verification error (payment was taken!):', verifyError);
            // DO NOT call onFailure — money was already deducted
            // The Firestore trigger will still detect the payment
            alert('Payment was successful but verification encountered an issue. Your order will be updated shortly.');
            setProcessingOrderId(null);
            setShowOverlay(false);
            setStatusMessage('');
          }
        }
      } else {
        // Web browser — use web SDK directly
        setProcessingOrderId(null);
        setStatusMessage('');
        openWebRazorpay(baseOptions, order, onSuccess, onFailure);
      }
    } catch (error: unknown) {
      console.error('Failed to create Razorpay order:', error);
      setProcessingOrderId(null);
      setShowOverlay(false);
      setStatusMessage('');
    }
  }, [processingOrderId, currentUser, updateOrderStatus]);

  const openWebRazorpay = (
    baseOptions: Record<string, unknown>,
    order: DocumentOrder,
    onSuccess: (id: string) => void,
    onFailure: (id: string) => void
  ) => {
    const webOptions = {
      ...baseOptions,
      handler: async function (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) {
        setShowOverlay(true);
        setStatusMessage('Verifying payment...');
        try {
          const verifyPaymentFn = httpsCallable(functions, 'verifyPayment');
          await verifyPaymentFn({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
            orderId: order.id,
          });
          onSuccess(order.id);
        } catch (verifyError: unknown) {
          console.error('Payment verification failed:', verifyError);
          onFailure(order.id);
        }
      },
      modal: {
        ondismiss: function () { setProcessingOrderId(null); setShowOverlay(false); setStatusMessage(''); },
        escape: true,
        animation: true,
      },
    };

    const rzp = new window.Razorpay(webOptions);
    rzp.on('payment.failed', function () {
      onFailure(order.id);
    });
    rzp.open();
  };

  const handleCancelOrder = async (order: DocumentOrder) => {
    // SAFETY: Before cancelling, check if the payment was actually captured
    // (handles case where verification failed but money was taken)
    if ((order.status === OrderStatus.PAYMENT_FAILED || order.status === OrderStatus.PENDING_PAYMENT) && order.razorpayOrderId) {
      try {
        const checkPaymentFn = httpsCallable(functions, 'checkPaymentStatus');
        const checkResult = await checkPaymentFn({ orderId: order.id });
        const checkData = checkResult.data as { paid: boolean; recovered?: boolean; message: string };

        if (checkData.paid && checkData.recovered) {
          alert('Your previous payment was actually successful! The order has been recovered instead of cancelled.');
          return;
        }

        if (checkData.paid && !checkData.recovered) {
          // Payment exists but order is already in a paid state
          if (!window.confirm('A payment was captured for this order. Cancelling will trigger an automatic refund. Continue?')) {
            return;
          }
        }
      } catch (checkErr) {
        console.warn('Payment check before cancel failed:', checkErr);
        // Continue with cancel if check fails
      }
    } else {
      if (!window.confirm("Are you sure you want to cancel this order?")) return;
    }

    try {
      const result = await updateOrderStatus(order.id, OrderStatus.CANCELLED, {
        actingUserType: UserType.STUDENT
      });
      if (!result) {
        alert('Failed to cancel order. Please try again.');
      }
    } catch (err) {
      console.error('[StudentOrderList] Cancel order failed:', err);
      alert('Failed to cancel order. Please check your connection and try again.');
    }
  };

  const [activeTab, setActiveTab] = useState<'recent' | 'history'>('recent');

  // Apply optimistic statuses to all orders
  const ordersWithOptimistic = orders.map(order => {
    const optimisticStatus = optimisticStatuses[order.id];
    if (optimisticStatus && order.status !== optimisticStatus) {
      return { ...order, status: optimisticStatus };
    }
    return order;
  });

  // Sort: pending payment first, then payment failed, then by date
  const sortAll = (list: DocumentOrder[]) => [...list].sort((a, b) => {
    if (a.status === OrderStatus.PENDING_PAYMENT && b.status !== OrderStatus.PENDING_PAYMENT) return -1;
    if (a.status !== OrderStatus.PENDING_PAYMENT && b.status === OrderStatus.PENDING_PAYMENT) return 1;
    if (a.status === OrderStatus.PAYMENT_FAILED && b.status !== OrderStatus.PAYMENT_FAILED) return -1;
    if (a.status !== OrderStatus.PAYMENT_FAILED && b.status === OrderStatus.PAYMENT_FAILED) return 1;
    return new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
  });

  // Recent: only active (non-cancelled, non-completed), max 5
  const activeOrders = ordersWithOptimistic.filter(o =>
    o.status !== OrderStatus.CANCELLED && o.status !== OrderStatus.COMPLETED
  );
  const recentOrders = sortAll(activeOrders).slice(0, 5);

  // History: all orders sorted by date (newest first)
  const allOrdersSorted = [...ordersWithOptimistic].sort((a, b) =>
    new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  );

  const cancelledCount = ordersWithOptimistic.filter(o => o.status === OrderStatus.CANCELLED).length;
  const completedCount = ordersWithOptimistic.filter(o => o.status === OrderStatus.COMPLETED).length;

  if (orders.length === 0) {
    return <p className="text-brand-lightText text-center py-6">No orders found.</p>;
  }

  const renderOrders = activeTab === 'recent' ? recentOrders : allOrdersSorted;

  return (
    <div className="space-y-4">
      {/* Tab Switcher */}
      <div className="flex bg-gray-100 dark:bg-zinc-800/80 rounded-xl p-1 gap-1">
        <button
          onClick={() => setActiveTab('recent')}
          className={`flex-1 relative py-2 px-3 text-sm font-medium rounded-lg transition-all duration-200
            ${activeTab === 'recent'
              ? 'bg-white dark:bg-zinc-900 text-gray-900 dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
        >
          Recent
          {activeOrders.length > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-red-500 text-white">
              {activeOrders.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`flex-1 relative py-2 px-3 text-sm font-medium rounded-lg transition-all duration-200
            ${activeTab === 'history'
              ? 'bg-white dark:bg-zinc-900 text-gray-900 dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
        >
          Order History
          {(cancelledCount + completedCount) > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-gray-300 dark:bg-zinc-600 text-gray-700 dark:text-gray-300">
              {cancelledCount + completedCount}
            </span>
          )}
        </button>
      </div>

      {/* Orders */}
      {renderOrders.length > 0 ? (
        <div className="space-y-6">
          {renderOrders.map(order => (
            <StudentOrderCard
              key={order.id}
              order={order}
              onPayNow={handlePayNow}
              onCancelOrder={handleCancelOrder}
              isProcessingPayment={processingOrderId === order.id}
            />
          ))}
          {activeTab === 'recent' && activeOrders.length > 5 && (
            <button
              onClick={() => setActiveTab('history')}
              className="w-full py-2.5 text-sm font-medium text-brand-primary hover:text-brand-primary/80 transition-colors"
            >
              View all {activeOrders.length} active orders →
            </button>
          )}
        </div>
      ) : (
        <div className="text-center py-8">
          <p className="text-gray-500 dark:text-gray-400">
            {activeTab === 'recent' ? 'No active orders' : 'No orders yet'}
          </p>
        </div>
      )}

      {showOverlay && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl p-6 flex flex-col items-center gap-3 mx-4 max-w-xs w-full">
            <Spinner size="md" />
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{statusMessage || 'Processing...'}</p>
            <p className="text-[10px] text-gray-400">Please do not close this page</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default StudentOrderList;