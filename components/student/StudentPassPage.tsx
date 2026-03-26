import React, { useEffect, useState } from 'react';
import { Button } from '../common/Button';
import { useAppContext } from '../../contexts/AppContext';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../../firebase';

const RAZORPAY_KEY_ID = import.meta.env.VITE_RAZORPAY_KEY_ID;
const functions = getFunctions(app, 'asia-south1');

const EzyPrintLogo: React.FC<{ className?: string }> = ({ className = '' }) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7H5v-1c0-.55.45-1 1-1h12c.55 0 1 .45 1 1v1zm-1-9H6v4h12V3z" />
        <path fill="none" d="M0 0h24v24H0z" />
    </svg>
);

const CheckIcon: React.FC = () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
        <path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z" clipRule="evenodd" />
    </svg>
);

const SparkleIcon: React.FC = () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
        <path fillRule="evenodd" d="M9 4.5a.75.75 0 0 1 .721.544l.813 2.846a3.75 3.75 0 0 0 2.576 2.576l2.846.813a.75.75 0 0 1 0 1.442l-2.846.813a3.75 3.75 0 0 0-2.576 2.576l-.813 2.846a.75.75 0 0 1-1.442 0l-.813-2.846a3.75 3.75 0 0 0-2.576-2.576l-2.846-.813a.75.75 0 0 1 0-1.442l2.846-.813a3.75 3.75 0 0 0 2.576-2.576l.813-2.846A.75.75 0 0 1 9 4.5Z" clipRule="evenodd" />
    </svg>
);

const StudentPassPage: React.FC = () => {
    useEffect(() => {
        window.scrollTo(0, 0);
    }, []);

    const { currentUser, upgradeToStudentPass, cancelStudentPass, navigateTo } = useAppContext();
    const [isProcessing, setIsProcessing] = useState(false);
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    const [statusMessage, setStatusMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');

    const handleUpgrade = async () => {
        if (!currentUser) {
            navigateTo('login');
            return;
        }

        setIsProcessing(true);
        setStatusMessage('Creating secure order...');
        setErrorMessage('');

        try {
            // Step 1: Create a server-side Razorpay order for the Student Pass
            const createPassOrderFn = httpsCallable(functions, 'createPassOrder');
            const result = await createPassOrderFn({});
            const data = result.data as {
                razorpayOrderId: string;
                amount: number;
                currency: string;
            };

            setStatusMessage('Opening payment gateway...');

            // Step 2: Open Razorpay checkout with server-generated order ID
            const options = {
                key: RAZORPAY_KEY_ID,
                amount: data.amount,
                currency: data.currency,
                name: 'EzyPrint',
                description: 'Student Pass - Monthly Subscription',
                order_id: data.razorpayOrderId,
                handler: async function (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) {
                    // Step 3: Verify payment server-side
                    setStatusMessage('Verifying payment...');
                    try {
                        const verifyPassPaymentFn = httpsCallable(functions, 'verifyPassPayment');
                        await verifyPassPaymentFn({
                            razorpay_order_id: response.razorpay_order_id,
                            razorpay_payment_id: response.razorpay_payment_id,
                            razorpay_signature: response.razorpay_signature,
                        });
                        // Also update local state
                        await upgradeToStudentPass();
                    } catch (verifyError: unknown) {
                        console.error('Pass payment verification failed:', verifyError);
                        setErrorMessage('Payment verification failed. If you were charged, please contact support.');
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
                    user_id: currentUser?.id,
                    subscription_type: 'student_pass',
                },
                theme: {
                    color: '#EAB308',
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

            const rzp = new (window as unknown as { Razorpay: new (opts: Record<string, unknown>) => { on: (event: string, cb: () => void) => void; open: () => void } }).Razorpay(options);
            rzp.on('payment.failed', function () {
                setIsProcessing(false);
                setStatusMessage('');
                setErrorMessage('Payment failed. Please try again or use a different payment method.');
            });
            rzp.open();
        } catch (error: unknown) {
            console.error('Failed to create pass order:', error);
            setIsProcessing(false);
            setStatusMessage('');
            setErrorMessage('Could not create order. Please check your connection and try again.');
        }
    };

    const handleCancel = async () => {
        setIsProcessing(true);
        const result = await cancelStudentPass();
        setIsProcessing(false);
        setShowCancelConfirm(false);

        if (result.success) {
            // Stay on page to show the updated status
        }
    };

    const benefits = [
        { text: '₹0 Service Fee on orders under ₹30', highlight: true },
        { text: 'Priority support for pass holders', highlight: false },
        { text: 'Exclusive access to special promotions', highlight: false },
        { text: 'More exciting benefits coming soon!', highlight: false, isUpcoming: true },
    ];

    // Premium member view - Manage Subscription
    if (currentUser?.hasStudentPass) {
        return (
            <div className="min-h-[80vh] flex flex-col items-center justify-center py-12 px-4 pt-32">
                {/* Background decorations */}
                <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
                    <div className="absolute top-20 left-10 w-72 h-72 bg-yellow-400/10 rounded-full blur-3xl"></div>
                    <div className="absolute bottom-20 right-10 w-96 h-96 bg-yellow-500/10 rounded-full blur-3xl"></div>
                </div>

                <div className="relative z-10 max-w-lg w-full">
                    {/* Header */}
                    <div className="text-center mb-8">
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-yellow-400 to-yellow-600 text-white mb-4 shadow-lg shadow-yellow-500/30">
                            <EzyPrintLogo className="w-9 h-9" />
                        </div>
                        <h1 className="text-3xl sm:text-4xl font-extrabold text-brand-text dark:text-white mb-2">
                            Manage Subscription
                        </h1>
                        <p className="text-brand-lightText dark:text-gray-400 text-lg">Your Student Pass is active</p>
                    </div>

                    {/* Status Card */}
                    <div className="bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl shadow-black/10 dark:shadow-black/30 overflow-hidden border border-gray-200 dark:border-zinc-800">
                        {/* Status Header */}
                        <div className="bg-gradient-to-r from-yellow-400 via-yellow-500 to-yellow-600 p-6 text-center relative overflow-hidden">
                            <div className="relative flex items-center justify-center gap-3">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-black">
                                    <path fillRule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z" clipRule="evenodd" />
                                </svg>
                                <span className="text-2xl font-black text-black">Premium Member</span>
                            </div>
                            <p className="text-yellow-900/70 text-sm mt-2">Your subscription is currently active</p>
                        </div>

                        {/* Benefits Section */}
                        <div className="p-6 sm:p-8">
                            <h3 className="text-lg font-bold text-brand-text dark:text-white mb-4">Your benefits:</h3>
                            <ul className="space-y-4">
                                {benefits.map((benefit, index) => (
                                    <li key={index} className="flex items-start gap-3">
                                        <span className={`flex-shrink-0 mt-0.5 ${benefit.isUpcoming ? 'text-yellow-500' : 'text-green-500'}`}>
                                            {benefit.isUpcoming ? <SparkleIcon /> : <CheckIcon />}
                                        </span>
                                        <span className={`${benefit.highlight ? 'text-brand-text dark:text-white font-semibold' : 'text-brand-lightText dark:text-gray-400'}`}>
                                            {benefit.text}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>

                        {/* Actions Section */}
                        <div className="px-6 sm:px-8 pb-6 sm:pb-8 space-y-3">
                            <Button
                                type="button"
                                variant="primary"
                                size="lg"
                                fullWidth
                                onClick={() => navigateTo('studentDashboard')}
                            >
                                Back to Dashboard
                            </Button>

                            {!showCancelConfirm ? (
                                <button
                                    type="button"
                                    onClick={() => setShowCancelConfirm(true)}
                                    className="w-full text-center text-sm text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 py-2 transition-colors"
                                >
                                    Cancel Subscription
                                </button>
                            ) : (
                                <div className="p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
                                    <p className="text-sm text-red-700 dark:text-red-300 mb-3">
                                        Are you sure you want to cancel? You'll lose your ₹0 service fee benefit on orders under ₹30.
                                    </p>
                                    <div className="flex gap-2">
                                        <Button
                                            type="button"
                                            variant="danger"
                                            size="sm"
                                            onClick={handleCancel}
                                            disabled={isProcessing}
                                        >
                                            {isProcessing ? 'Cancelling...' : 'Yes, Cancel'}
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setShowCancelConfirm(false)}
                                            disabled={isProcessing}
                                        >
                                            Keep Subscription
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // Non-premium view - Get Pass
    return (
        <div className="min-h-[80vh] flex flex-col items-center justify-center py-12 px-4 pt-32">
            {/* Background decorations */}
            <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
                <div className="absolute top-20 left-10 w-72 h-72 bg-yellow-400/10 rounded-full blur-3xl"></div>
                <div className="absolute bottom-20 right-10 w-96 h-96 bg-yellow-500/10 rounded-full blur-3xl"></div>
            </div>

            <div className="relative z-10 max-w-lg w-full">
                {/* Header */}
                <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-yellow-400 to-yellow-600 text-white mb-4 shadow-lg shadow-yellow-500/30">
                        <EzyPrintLogo className="w-9 h-9" />
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-extrabold text-brand-text dark:text-white mb-2">
                        <span className="text-brand-primary">EZYPRINT</span> Student Pass
                    </h1>
                    <p className="text-brand-lightText dark:text-gray-400 text-lg">Save more on every print order</p>
                </div>

                {/* Main Card */}
                <div className="bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl shadow-black/10 dark:shadow-black/30 overflow-hidden border border-gray-200 dark:border-zinc-800">
                    {/* Price Section */}
                    <div className="bg-gradient-to-r from-yellow-400 via-yellow-500 to-yellow-600 p-6 text-center relative overflow-hidden">
                        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxjaXJjbGUgY3g9IjIwIiBjeT0iMjAiIHI9IjIiIGZpbGw9InJnYmEoMjU1LDI1NSwyNTUsMC4xKSIvPjwvZz48L3N2Zz4=')] opacity-50"></div>
                        <div className="relative">
                            <p className="text-yellow-900/80 text-sm font-medium mb-1 uppercase tracking-wider">Student Pass</p>
                            <div className="flex items-end justify-center gap-1">
                                <span className="text-5xl sm:text-6xl font-black text-black">₹49</span>
                                <span className="text-xl text-black/70 font-medium mb-2">/month</span>
                            </div>
                            <p className="text-yellow-900/70 text-sm mt-2">Cancel anytime • No hidden fees</p>
                        </div>
                    </div>

                    {/* Benefits Section */}
                    <div className="p-6 sm:p-8">
                        <h3 className="text-lg font-bold text-brand-text dark:text-white mb-4">What you get:</h3>
                        <ul className="space-y-4">
                            {benefits.map((benefit, index) => (
                                <li key={index} className="flex items-start gap-3">
                                    <span className={`flex-shrink-0 mt-0.5 ${benefit.isUpcoming ? 'text-yellow-500' : 'text-green-500'}`}>
                                        {benefit.isUpcoming ? <SparkleIcon /> : <CheckIcon />}
                                    </span>
                                    <span className={`${benefit.highlight ? 'text-brand-text dark:text-white font-semibold' : 'text-brand-lightText dark:text-gray-400'}`}>
                                        {benefit.text}
                                    </span>
                                </li>
                            ))}
                        </ul>

                        {/* Savings callout */}
                        <div className="mt-6 p-4 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/50">
                            <div className="flex items-center gap-3">
                                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-green-100 dark:bg-green-800/50 flex items-center justify-center">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-green-600 dark:text-green-400">
                                        <path d="M12 7.5a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5Z" />
                                        <path fillRule="evenodd" d="M1.5 4.875C1.5 3.839 2.34 3 3.375 3h17.25c1.035 0 1.875.84 1.875 1.875v9.75c0 1.036-.84 1.875-1.875 1.875H3.375A1.875 1.875 0 0 1 1.5 14.625v-9.75ZM8.25 9.75a3.75 3.75 0 1 1 7.5 0 3.75 3.75 0 0 1-7.5 0ZM18.75 9a.75.75 0 0 0-.75.75v.008c0 .414.336.75.75.75h.008a.75.75 0 0 0 .75-.75V9.75a.75.75 0 0 0-.75-.75h-.008ZM4.5 9.75A.75.75 0 0 1 5.25 9h.008a.75.75 0 0 1 .75.75v.008a.75.75 0 0 1-.75.75H5.25a.75.75 0 0 1-.75-.75V9.75Z" clipRule="evenodd" />
                                        <path d="M2.25 18a.75.75 0 0 0 0 1.5c5.4 0 10.63.722 15.6 2.075 1.19.324 2.4-.558 2.4-1.82V18.75a.75.75 0 0 0-.75-.75H2.25Z" />
                                    </svg>
                                </div>
                                <div>
                                    <p className="text-sm font-semibold text-green-800 dark:text-green-300">Save up to ₹36/month</p>
                                    <p className="text-xs text-green-700/80 dark:text-green-400/70">Based on 12 orders under ₹30 each</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* CTA Section */}
                    <div className="px-6 sm:px-8 pb-6 sm:pb-8">
                        {errorMessage && (
                            <div className="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 text-sm text-red-700 dark:text-red-300 text-center">
                                {errorMessage}
                            </div>
                        )}
                        <Button
                            type="button"
                            variant="primary"
                            size="lg"
                            fullWidth
                            className="!bg-gradient-to-r !from-yellow-400 !to-yellow-600 hover:!from-yellow-500 hover:!to-yellow-700 !text-black font-bold shadow-lg shadow-yellow-500/30 hover:shadow-yellow-500/40 transition-all transform hover:-translate-y-0.5"
                            onClick={handleUpgrade}
                            disabled={isProcessing}
                        >
                            {isProcessing ? (statusMessage || 'Processing...') : 'Get Student Pass Now'}
                        </Button>
                        <p className="text-[11px] text-brand-lightText dark:text-gray-500 mt-4 text-center">
                            By clicking "Get Student Pass Now", you agree to our terms and conditions.
                        </p>
                    </div>
                </div>

                {/* Back link */}
                <div className="text-center mt-6">
                    <button
                        onClick={() => navigateTo('studentDashboard')}
                        className="text-sm text-brand-lightText dark:text-gray-400 hover:text-brand-primary transition-colors"
                    >
                        ← Back to Dashboard
                    </button>
                </div>
            </div>
        </div>
    );
};

export default StudentPassPage;
