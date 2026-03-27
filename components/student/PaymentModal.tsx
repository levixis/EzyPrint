import React, { useState, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { DocumentOrder, PrintColor } from '../../types';
import { getOrderFiles, getOrderDisplayName } from '../../utils/orderHelpers';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Spinner } from '../common/Spinner';
import { useAppContext } from '../../contexts/AppContext';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../../firebase';

const RAZORPAY_KEY_ID = import.meta.env.VITE_RAZORPAY_KEY_ID;
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

async function openNativeRazorpay(options: Record<string, unknown>): Promise<{ razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }> {
    const { Checkout } = await import('capacitor-razorpay');
    const result = await Checkout.open(options as { key: string; amount: string });
    const response = typeof result.response === 'string' ? JSON.parse(result.response) : result.response;
    return response as { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
}

const PaymentModal: React.FC<PaymentModalProps> = ({ isOpen, onClose, order, onPaymentSuccess, onPaymentFailure }) => {
    const { getShopById, currentUser } = useAppContext();
    const [isProcessing, setIsProcessing] = useState(false);
    const [statusMessage, setStatusMessage] = useState('');
    const [isMobile, setIsMobile] = useState(false);
    const shop = getShopById(order.shopId);

    // Detect mobile
    useEffect(() => {
        const check = () => setIsMobile(window.innerWidth < 640);
        check();
        window.addEventListener('resize', check);
        return () => window.removeEventListener('resize', check);
    }, []);

    // Lock body scroll on mobile when modal is open
    useEffect(() => {
        if (isOpen && isMobile) {
            document.body.style.overflow = 'hidden';
            return () => { document.body.style.overflow = ''; };
        }
    }, [isOpen, isMobile]);

    const openRazorpayCheckout = async () => {
        setIsProcessing(true);
        setStatusMessage('Creating secure order...');

        try {
            const createOrderFn = httpsCallable(functions, 'createOrder');
            const result = await createOrderFn({ orderId: order.id });
            const data = result.data as {
                razorpayOrderId: string;
                amount: number;
                currency: string;
                verifiedPrice: { pageCost: number; baseFee: number; totalPrice: number };
            };

            setStatusMessage('Opening payment gateway...');

            const baseOptions = {
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

            if (Capacitor.isNativePlatform()) {
                try {
                    const response = await openNativeRazorpay(baseOptions);
                    setStatusMessage('Verifying payment...');
                    const verifyPaymentFn = httpsCallable(functions, 'verifyPayment');
                    await verifyPaymentFn({
                        razorpay_order_id: response.razorpay_order_id,
                        razorpay_payment_id: response.razorpay_payment_id,
                        razorpay_signature: response.razorpay_signature,
                        orderId: order.id,
                    });
                    onPaymentSuccess(order.id);
                } catch (nativeError: unknown) {
                    console.error('Native Razorpay error:', nativeError);
                    onPaymentFailure(order.id);
                } finally {
                    setIsProcessing(false);
                    setStatusMessage('');
                }
            } else {
                const webOptions = {
                    ...baseOptions,
                    handler: async function (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) {
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
                    modal: {
                        ondismiss: function () { setIsProcessing(false); setStatusMessage(''); },
                        escape: true,
                        animation: true,
                    },
                };

                const rzp = new window.Razorpay(webOptions);
                rzp.on('payment.failed', function () {
                    onPaymentFailure(order.id);
                    setIsProcessing(false);
                    setStatusMessage('');
                });
                rzp.open();
            }
        } catch (error: unknown) {
            console.error('Failed to create Razorpay order:', error);
            setStatusMessage('');
            setIsProcessing(false);
        }
    };

    const files = getOrderFiles(order);
    const fileLabel = files.length === 1 ? files[0].fileName : `${files.length} files`;
    const colorLabel = files.length === 1 ? (files[0].color === PrintColor.COLOR ? 'Color' : 'B&W') : '';

    if (!isOpen) return null;

    // ─── Shared payment content ───
    const paymentContent = (
        <div className={isMobile ? '' : 'text-center'}>
            {/* Compact header — mobile only (desktop uses Modal title) */}
            {isMobile && (
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-red-500 to-red-600 flex items-center justify-center shadow-md">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-white">
                                <path d="M4.5 3.75a3 3 0 0 0-3 3v.75h21v-.75a3 3 0 0 0-3-3h-15Z" />
                                <path fillRule="evenodd" d="M22.5 9.75h-21v7.5a3 3 0 0 0 3 3h15a3 3 0 0 0 3-3v-7.5Zm-18 3.75a.75.75 0 0 1 .75-.75h6a.75.75 0 0 1 0 1.5h-6a.75.75 0 0 1-.75-.75Zm.75 2.25a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Z" clipRule="evenodd" />
                            </svg>
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-gray-900 dark:text-white leading-tight">Complete Payment</h2>
                            <p className="text-[10px] text-gray-400">Order #{order.id.slice(-6)}</p>
                        </div>
                    </div>
                    {!isProcessing && (
                        <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-400">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                            </svg>
                        </button>
                    )}
                </div>
            )}

            {/* Desktop header icon */}
            {!isMobile && (
                <div className="mb-3">
                    <div className="w-11 h-11 mx-auto mb-2 rounded-xl bg-gradient-to-br from-red-500 to-red-600 flex items-center justify-center shadow-md">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white">
                            <path d="M4.5 3.75a3 3 0 0 0-3 3v.75h21v-.75a3 3 0 0 0-3-3h-15Z" />
                            <path fillRule="evenodd" d="M22.5 9.75h-21v7.5a3 3 0 0 0 3 3h15a3 3 0 0 0 3-3v-7.5Zm-18 3.75a.75.75 0 0 1 .75-.75h6a.75.75 0 0 1 0 1.5h-6a.75.75 0 0 1-.75-.75Zm.75 2.25a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Z" clipRule="evenodd" />
                        </svg>
                    </div>
                    <h2 className="text-lg font-bold text-gray-900 dark:text-white">Complete Payment</h2>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Order #{order.id.slice(-6)}</p>
                </div>
            )}

            {/* File + breakdown */}
            <div className="bg-gray-50 dark:bg-zinc-800/60 rounded-xl p-3 mb-3 text-left">
                <div className="flex items-center gap-2 mb-2">
                    <div className="w-6 h-6 rounded bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 text-red-500">
                            <path fillRule="evenodd" d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V6.75L14.625 1.5h-9Z" clipRule="evenodd" />
                        </svg>
                    </div>
                    <p className="text-xs font-medium text-gray-700 dark:text-gray-200 truncate flex-1">{fileLabel}</p>
                    <span className="text-[10px] text-gray-400 flex-shrink-0">{shop?.name}{colorLabel ? ` · ${colorLabel}` : ''}</span>
                </div>
                <div className="grid grid-cols-3 text-[11px] text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-zinc-700 pt-2">
                    {files.length === 1 ? (
                        <>
                            <span>{files[0].pageCount}pg × {files[0].copies}cp</span>
                            <span className="text-center">Print ₹{order.priceDetails.pageCost.toFixed(2)}</span>
                            <span className="text-right">Fee ₹{order.priceDetails.baseFee.toFixed(2)}</span>
                        </>
                    ) : (
                        <>
                            <span>{order.printOptions.pages}pg total</span>
                            <span className="text-center">Print ₹{order.priceDetails.pageCost.toFixed(2)}</span>
                            <span className="text-right">Fee ₹{order.priceDetails.baseFee.toFixed(2)}</span>
                        </>
                    )}
                </div>
            </div>

            {/* Action */}
            {isProcessing ? (
                <div className="flex items-center justify-center gap-3 py-4">
                    <Spinner size="sm" />
                    <p className="text-sm text-gray-500 dark:text-gray-400">{statusMessage || 'Processing...'}</p>
                </div>
            ) : (
                <div className="space-y-2">
                    <div className="flex justify-between items-center px-1 mb-1">
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Total</span>
                        <span className="text-2xl font-bold text-gray-900 dark:text-white">₹{order.priceDetails.totalPrice.toFixed(2)}</span>
                    </div>
                    <Button
                        onClick={openRazorpayCheckout}
                        variant="primary"
                        size="lg"
                        fullWidth
                        className="!bg-gradient-to-r !from-red-500 !to-red-600 hover:!from-red-600 hover:!to-red-700 !text-white font-bold shadow-lg shadow-red-500/25"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 mr-2">
                            <path fillRule="evenodd" d="M12 1.5a5.25 5.25 0 0 0-5.25 5.25v3a3 3 0 0 0-3 3v6.75a3 3 0 0 0 3 3h10.5a3 3 0 0 0 3-3v-6.75a3 3 0 0 0-3-3v-3c0-2.9-2.35-5.25-5.25-5.25Zm3.75 8.25v-3a3.75 3.75 0 1 0-7.5 0v3h7.5Z" clipRule="evenodd" />
                        </svg>
                        Pay ₹{order.priceDetails.totalPrice.toFixed(2)}
                    </Button>
                    <button
                        onClick={onClose}
                        className="w-full py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 transition-colors"
                    >
                        Cancel
                    </button>
                </div>
            )}

            <div className="mt-2 flex items-center justify-center gap-1.5 text-[10px] text-gray-400 dark:text-gray-500">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3">
                    <path fillRule="evenodd" d="M12 1.5a5.25 5.25 0 0 0-5.25 5.25v3a3 3 0 0 0-3 3v6.75a3 3 0 0 0 3 3h10.5a3 3 0 0 0 3-3v-6.75a3 3 0 0 0-3-3v-3c0-2.9-2.35-5.25-5.25-5.25Zm3.75 8.25v-3a3.75 3.75 0 1 0-7.5 0v3h7.5Z" clipRule="evenodd" />
                </svg>
                Secured by Razorpay
            </div>
        </div>
    );

    // ─── MOBILE: Full-screen overlay ───
    if (isMobile) {
        return (
            <div className="fixed inset-0 z-[200] flex items-center justify-center">
                <div className="absolute inset-0 bg-black/60" onClick={isProcessing ? undefined : onClose} />
                <div className="relative z-10 bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl mx-4 w-full max-w-sm p-5">
                    {paymentContent}
                </div>
            </div>
        );
    }

    // ─── DESKTOP: Original Modal wrapper ───
    return (
        <Modal
            isOpen={isOpen}
            onClose={isProcessing ? () => {} : onClose}
            title=""
            size="sm"
            hideCloseButton={isProcessing}
        >
            {paymentContent}
        </Modal>
    );
};

export default PaymentModal;
