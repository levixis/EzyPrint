import React, { useState } from 'react';
import { DocumentOrder, PrintColor } from '../../types';
import { getOrderFiles, getOrderDisplayName } from '../../utils/orderHelpers';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Spinner } from '../common/Spinner';
import { useAppContext } from '../../contexts/AppContext';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../../firebase';

// Razorpay Key ID — loaded from environment variable for easy rotation
const RAZORPAY_KEY_ID = import.meta.env.VITE_RAZORPAY_KEY_ID;

// Firebase Functions instance (asia-south1 region to match deployed functions)
const functions = getFunctions(app, 'asia-south1');

interface PaymentModalProps {
    isOpen: boolean;
    onClose: () => void;
    order: DocumentOrder;
    onPaymentSuccess: (orderId: string) => void;
    onPaymentFailure: (orderId: string) => void;
}

declare global {
    interface Window {
        Razorpay: new (opts: Record<string, unknown>) => { on: (event: string, cb: () => void) => void; open: () => void };
    }
}

const PaymentModal: React.FC<PaymentModalProps> = ({ isOpen, onClose, order, onPaymentSuccess, onPaymentFailure }) => {
    const { getShopById, currentUser } = useAppContext();
    const [isProcessing, setIsProcessing] = useState(false);
    const [statusMessage, setStatusMessage] = useState('');
    const shop = getShopById(order.shopId);

    const openRazorpayCheckout = async () => {
        setIsProcessing(true);
        setStatusMessage('Creating secure order...');

        try {
            // Step 1: Call Cloud Function to create a server-verified Razorpay order
            const createOrderFn = httpsCallable(functions, 'createOrder');
            const result = await createOrderFn({ orderId: order.id });
            const data = result.data as {
                razorpayOrderId: string;
                amount: number;
                currency: string;
                verifiedPrice: { pageCost: number; baseFee: number; totalPrice: number };
            };

            setStatusMessage('Opening payment gateway...');

            // Step 2: Open Razorpay checkout with server-generated order ID
            const options = {
                key: RAZORPAY_KEY_ID,
                amount: data.amount,
                currency: data.currency,
                name: 'EzyPrint',
                description: `Order #${order.id.slice(-6)} - ${getOrderDisplayName(order)}`,
                order_id: data.razorpayOrderId, // Server-generated order ID
                handler: async function (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) {
                    // Step 3: Verify payment server-side
                    setStatusMessage('Verifying payment...');
                    try {
                        const verifyPaymentFn = httpsCallable(functions, 'verifyPayment');
                        await verifyPaymentFn({
                            razorpay_order_id: response.razorpay_order_id,
                            razorpay_payment_id: response.razorpay_payment_id,
                            razorpay_signature: response.razorpay_signature,
                            orderId: order.id,
                        });
                        onPaymentSuccess(order.id);
                    } catch (verifyError: unknown) {
                        console.error('Payment verification failed:', verifyError);
                        onPaymentFailure(order.id);
                    } finally {
                        setIsProcessing(false);
                        setStatusMessage('');
                    }
                },
                prefill: {
                    name: currentUser?.name || '',
                    email: currentUser?.email || '',
                },
                notes: {
                    order_id: order.id,
                    shop_id: order.shopId,
                },
                theme: {
                    color: '#EF4444',
                },
                modal: {
                    ondismiss: function () {
                        setIsProcessing(false);
                        setStatusMessage('');
                    },
                    escape: true,
                    animation: true,
                },
            };

            const rzp = new window.Razorpay(options);
            rzp.on('payment.failed', function () {
                onPaymentFailure(order.id);
                setIsProcessing(false);
                setStatusMessage('');
            });
            rzp.open();
        } catch (error: unknown) {
            console.error('Failed to create Razorpay order:', error);
            setStatusMessage('');
            setIsProcessing(false);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={isProcessing ? () => { } : onClose}
            title=""
            size="sm"
            hideCloseButton={isProcessing}
        >
            <div className="text-center">
                <div className="mb-6">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-red-500 to-red-600 flex items-center justify-center shadow-lg">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-white">
                            <path d="M4.5 3.75a3 3 0 0 0-3 3v.75h21v-.75a3 3 0 0 0-3-3h-15Z" />
                            <path fillRule="evenodd" d="M22.5 9.75h-21v7.5a3 3 0 0 0 3 3h15a3 3 0 0 0 3-3v-7.5Zm-18 3.75a.75.75 0 0 1 .75-.75h6a.75.75 0 0 1 0 1.5h-6a.75.75 0 0 1-.75-.75Zm.75 2.25a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Z" clipRule="evenodd" />
                        </svg>
                    </div>
                    <h2 className="text-xl font-bold text-gray-900 dark:text-white">Complete Payment</h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Order #{order.id.slice(-6)}</p>
                </div>

                <div className="bg-gray-50 dark:bg-zinc-800/50 rounded-xl p-4 mb-6 text-left">
                    <div className="flex items-start gap-3 mb-3 pb-3 border-b border-gray-200 dark:border-zinc-700">
                        <div className="w-10 h-10 rounded-lg bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-red-600 dark:text-red-400">
                                <path fillRule="evenodd" d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V6.75L14.625 1.5h-9Z" clipRule="evenodd" />
                            </svg>
                        </div>
                    <div className="flex-1 min-w-0">
                            {(() => {
                              const files = getOrderFiles(order);
                              if (files.length === 1) {
                                return (
                                  <>
                                    <p className="font-medium text-gray-900 dark:text-white truncate">{files[0].fileName}</p>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">{shop?.name || 'Print Shop'} • {files[0].color === PrintColor.COLOR ? 'Color' : 'B&W'}</p>
                                  </>
                                );
                              }
                              return (
                                <>
                                  <p className="font-medium text-gray-900 dark:text-white">{files.length} files</p>
                                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{files.map(f => f.fileName).join(', ')}</p>
                                </>
                              );
                            })()}
                        </div>
                    </div>

                    <div className="space-y-2 text-sm">
                        <div className="flex justify-between text-gray-600 dark:text-gray-300">
                            <span>{order.printOptions.pages} pages × {order.printOptions.copies} copies</span>
                            <span>{order.printOptions.color === 'BLACK_WHITE' ? 'B&W' : 'Color'}</span>
                        </div>
                        <div className="flex justify-between text-gray-500 dark:text-gray-400">
                            <span>Print Cost</span>
                            <span>₹{order.priceDetails.pageCost.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-gray-500 dark:text-gray-400">
                            <span>Platform Fee</span>
                            <span>₹{order.priceDetails.baseFee.toFixed(2)}</span>
                        </div>
                    </div>
                </div>

                <div className="flex justify-between items-center mb-6 px-2">
                    <span className="text-lg font-medium text-gray-700 dark:text-gray-300">Total</span>
                    <span className="text-3xl font-bold text-gray-900 dark:text-white">₹{order.priceDetails.totalPrice.toFixed(2)}</span>
                </div>

                {isProcessing ? (
                    <div className="py-6">
                        <Spinner size="lg" />
                        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{statusMessage || 'Processing...'}</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <Button
                            onClick={openRazorpayCheckout}
                            variant="primary"
                            size="lg"
                            fullWidth
                            className="!bg-gradient-to-r !from-red-500 !to-red-600 hover:!from-red-600 hover:!to-red-700 !text-white font-bold shadow-lg shadow-red-500/25"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 mr-2">
                                <path d="M10.464 8.746c.227-.18.497-.311.786-.394v2.795a2.252 2.252 0 0 1-.786-.393c-.394-.313-.546-.681-.546-1.004 0-.323.152-.691.546-1.004ZM12.75 15.662v-2.824c.347.085.664.228.921.421.427.32.579.686.579.991 0 .305-.152.671-.579.991a2.534 2.534 0 0 1-.921.42Z" />
                                <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM12.75 6a.75.75 0 0 0-1.5 0v.816a3.836 3.836 0 0 0-1.72.756c-.712.566-1.112 1.35-1.112 2.178 0 .829.4 1.612 1.113 2.178.502.4 1.102.647 1.719.756v2.978a2.536 2.536 0 0 1-.921-.421l-.879-.66a.75.75 0 0 0-.9 1.2l.879.66c.533.4 1.169.645 1.821.75V18a.75.75 0 0 0 1.5 0v-.81a4.124 4.124 0 0 0 1.821-.749c.745-.559 1.179-1.344 1.179-2.191 0-.847-.434-1.632-1.179-2.191a4.122 4.122 0 0 0-1.821-.75V8.354c.29.082.559.213.786.393l.415.33a.75.75 0 0 0 .933-1.175l-.415-.33a3.836 3.836 0 0 0-1.719-.755V6Z" clipRule="evenodd" />
                            </svg>
                            Pay ₹{order.priceDetails.totalPrice.toFixed(2)}
                        </Button>
                        <button
                            onClick={onClose}
                            className="w-full py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                )}

                <div className="mt-6 flex items-center justify-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                        <path fillRule="evenodd" d="M12 1.5a5.25 5.25 0 0 0-5.25 5.25v3a3 3 0 0 0-3 3v6.75a3 3 0 0 0 3 3h10.5a3 3 0 0 0 3-3v-6.75a3 3 0 0 0-3-3v-3c0-2.9-2.35-5.25-5.25-5.25Zm3.75 8.25v-3a3.75 3.75 0 1 0-7.5 0v3h7.5Z" clipRule="evenodd" />
                    </svg>
                    Payment processed securely by EzyPrint via Razorpay
                </div>
            </div>
        </Modal>
    );
};

export default PaymentModal;
