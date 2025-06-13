import React, { useState } from 'react';
import { DocumentOrder, OrderStatus } from '../../types'; // Added OrderStatus
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Card } from '../common/Card';
import { Spinner } from '../common/Spinner';
import { useAppContext } from '../../contexts/AppContext'; // For getting shop name

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  order: DocumentOrder;
  onPaymentSuccess: (orderId: string) => void; // Removed razorpayOrderId from signature
  onPaymentFailure: (orderId: string) => void;
}

const PaymentModal: React.FC<PaymentModalProps> = ({ isOpen, onClose, order, onPaymentSuccess, onPaymentFailure }) => {
  const { getShopById } = useAppContext();
  const [isProcessing, setIsProcessing] = useState(false);
  const shop = getShopById(order.shopId);

  const handlePaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProcessing(true);

    // --- Conceptual Razorpay Integration Point ---
    // In a real app with a backend:
    // 1. Your backend creates a Razorpay Order ID (e.g., via an API call from here).
    // 2. You use that Razorpay Order ID to open Razorpay Checkout.
    //    (Code for RazorpayCheckout.open() would be here)
    // 3. Razorpay's `handler` function receives payment details (payment_id, signature).
    // 4. These details are sent to your backend for verification.
    // 5. If backend verification is successful, THEN you call onPaymentSuccess.
    //    If it fails (or Razorpay's `payment.failed` event fires), call onPaymentFailure.

    // Mocking API call and Razorpay interaction delay
    console.log(`Initiating mock Razorpay payment for Order ID: ${order.id}, Amount: ₹${order.priceDetails.totalPrice.toFixed(2)}`);
    await new Promise(resolve => setTimeout(resolve, 3000)); 

    // For this mock, we assume success after the delay.
    // In a real scenario, this would be conditional based on actual payment status.
    console.log(`Mock Razorpay payment successful for Order ID: ${order.id}`);
    onPaymentSuccess(order.id); // No razorpayOrderId passed up now
    setIsProcessing(false);
    // Modal will be closed by StudentOrderList
  };


  return (
    <Modal 
        isOpen={isOpen} 
        onClose={isProcessing ? () => {} : onClose} 
        title={`Payment for Order #${order.id.slice(-6)}`} 
        size="md" 
        hideCloseButton={isProcessing}
    >
      <form onSubmit={handlePaymentSubmit}>
        <Card className="bg-brand-secondaryLight/70 p-4 mb-6 text-left border-brand-muted/50">
          <p className="text-brand-lightText"><strong>File:</strong> {order.fileName}</p>
          {shop && <p className="text-brand-lightText"><strong>Shop:</strong> {shop.name}</p>}
          <p className="text-brand-lightText"><strong>Details:</strong> {order.printOptions.pages}pgs, {order.printOptions.copies}x, {order.printOptions.color.replace('_','&')}, {order.printOptions.doubleSided ? '2-sided' : '1-sided'}</p>
          <hr className="my-2 border-brand-muted/30"/>
          <div className="text-sm text-brand-lightText space-y-0.5">
            <div className="flex justify-between"><span>Page Cost:</span> <span>₹{order.priceDetails.pageCost.toFixed(2)}</span></div>
            <div className="flex justify-between"><span>Base Fee:</span> <span>₹{order.priceDetails.baseFee.toFixed(2)}</span></div>
          </div>
           <hr className="my-2 border-brand-muted/30"/>
          <p className="text-2xl font-bold text-brand-primary mt-2">Total Amount: ₹{order.priceDetails.totalPrice.toFixed(2)}</p>
        </Card>

        {isProcessing ? (
          <div className="text-center py-10">
            <Spinner size="lg" />
            <p className="mt-4 text-brand-lightText">Connecting to payment gateway...</p>
            <p className="text-xs text-brand-muted">Please do not refresh or close this window.</p>
          </div>
        ) : (
          <>
            <p className="text-sm text-brand-muted mb-6 text-center">
              You will be redirected to Razorpay to complete your payment securely.
            </p>
            <div className="mt-8 space-y-3">
              <Button 
                type="submit"
                variant="primary" 
                size="lg"
                fullWidth
                disabled={isProcessing}
                leftIcon={<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="feather feather-shield"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>}
              >
                Proceed to Pay ₹{order.priceDetails.totalPrice.toFixed(2)} via Razorpay
              </Button>
              <Button 
                onClick={onClose} 
                variant="ghost" 
                size="md"
                fullWidth
                disabled={isProcessing}
              >
                Cancel Payment
              </Button>
            </div>
             <p className="text-xs text-brand-muted mt-6 text-center">
              By clicking "Proceed", you will be redirected to Razorpay's secure payment page.
            </p>
          </>
        )}
      </form>
    </Modal>
  );
};

export default PaymentModal;
