import React from 'react';
import { useAppContext } from '../contexts/AppContext';
import { Button } from './common/Button';

const LandingPage: React.FC = () => {
    const { navigateTo } = useAppContext();

    return (
        <div className="min-h-[calc(100vh-120px)]">
            {/* Hero Section */}
            <section className="relative py-20 px-4 overflow-hidden">
                {/* Background gradient */}
                <div className="absolute inset-0 bg-gradient-to-br from-red-50 via-white to-orange-50 dark:from-brand-dark-bg dark:via-brand-dark-bg dark:to-brand-dark-bg" />

                {/* Decorative circles */}
                <div className="absolute top-20 left-10 w-72 h-72 bg-red-200/30 dark:bg-red-500/20 rounded-full blur-3xl" />
                <div className="absolute bottom-10 right-10 w-96 h-96 bg-orange-200/30 dark:bg-orange-500/15 rounded-full blur-3xl" />

                <div className="relative max-w-6xl mx-auto text-center">
                    {/* Logo */}
                    <div className="mb-8 inline-flex items-center justify-center">
                        <div className="p-4 rounded-2xl bg-gradient-to-br from-red-500 to-red-600 shadow-xl shadow-red-500/25">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-12 h-12 text-white">
                                <path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7H5v-1c0-.55.45-1 1-1h12c.55 0 1 .45 1 1v1zm-1-9H6v4h12V3z" />
                            </svg>
                        </div>
                    </div>

                    {/* Headline */}
                    <h1 className="text-5xl sm:text-6xl lg:text-7xl font-extrabold mb-6">
                        <span className="text-gray-900 dark:text-white">EZY</span>
                        <span className="text-brand-primary">PRINT</span>
                    </h1>

                    <p className="text-xl sm:text-2xl text-gray-600 dark:text-gray-300 mb-4 font-medium">
                        Pay • Print • Collect
                    </p>

                    <p className="text-lg text-gray-500 dark:text-gray-400 max-w-2xl mx-auto mb-10">
                        The smartest way to get your documents printed. Upload your files, pay securely,
                        and pick up from your nearest print shop. Simple, fast, and hassle-free.
                    </p>

                    {/* CTA Buttons */}
                    <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
                        <Button
                            onClick={() => navigateTo('login')}
                            variant="primary"
                            size="lg"
                            className="!px-8 !py-4 !text-lg shadow-xl shadow-red-500/25 hover:shadow-red-500/40 transition-shadow"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 mr-2">
                                <path fillRule="evenodd" d="M7.5 6a4.5 4.5 0 1 1 9 0 4.5 4.5 0 0 1-9 0ZM3.751 20.105a8.25 8.25 0 0 1 16.498 0 .75.75 0 0 1-.437.695A18.683 18.683 0 0 1 12 22.5c-2.786 0-5.433-.608-7.812-1.7a.75.75 0 0 1-.437-.695Z" clipRule="evenodd" />
                            </svg>
                            Get Started
                        </Button>
                        <Button
                            onClick={() => navigateTo('login')}
                            variant="secondary"
                            size="lg"
                            className="!px-8 !py-4 !text-lg !bg-white dark:!bg-zinc-800 !text-gray-700 dark:!text-white !border !border-gray-300 dark:!border-zinc-600 hover:!bg-gray-100 dark:hover:!bg-zinc-700"
                        >
                            I already have an account
                        </Button>
                    </div>
                </div>
            </section>

            {/* Features Section */}
            <section className="py-20 px-4 bg-white dark:bg-brand-dark-bg">
                <div className="max-w-6xl mx-auto">
                    <h2 className="text-3xl sm:text-4xl font-bold text-center text-gray-900 dark:text-white mb-4">
                        How It Works
                    </h2>
                    <p className="text-center text-gray-500 dark:text-gray-400 mb-16 max-w-2xl mx-auto">
                        Whether you're a student needing prints or a shop owner managing orders, EzyPrint makes it effortless.
                    </p>

                    {/* For Students */}
                    <div className="mb-16">
                        <h3 className="text-2xl font-semibold text-center text-brand-primary mb-8">For Students</h3>
                        <div className="grid md:grid-cols-3 gap-8">
                            {/* Step 1 */}
                            <div className="text-center p-6 rounded-2xl bg-gray-50 dark:bg-white/5 border border-gray-100 dark:border-white/10">
                                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-brand-primary">
                                        <path fillRule="evenodd" d="M10.5 3.75a6 6 0 0 0-5.98 6.496A5.25 5.25 0 0 0 6.75 20.25H18a4.5 4.5 0 0 0 2.206-8.423 3.75 3.75 0 0 0-4.133-4.303A6.001 6.001 0 0 0 10.5 3.75Zm2.25 6a.75.75 0 0 0-1.5 0v4.94l-1.72-1.72a.75.75 0 0 0-1.06 1.06l3 3a.75.75 0 0 0 1.06 0l3-3a.75.75 0 1 0-1.06-1.06l-1.72 1.72V9.75Z" clipRule="evenodd" />
                                    </svg>
                                </div>
                                <h4 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">1. Upload</h4>
                                <p className="text-gray-500 dark:text-gray-400">Upload your PDF documents and select your print preferences</p>
                            </div>

                            {/* Step 2 */}
                            <div className="text-center p-6 rounded-2xl bg-gray-50 dark:bg-white/5 border border-gray-100 dark:border-white/10">
                                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-brand-primary">
                                        <path d="M4.5 3.75a3 3 0 0 0-3 3v.75h21v-.75a3 3 0 0 0-3-3h-15Z" />
                                        <path fillRule="evenodd" d="M22.5 9.75h-21v7.5a3 3 0 0 0 3 3h15a3 3 0 0 0 3-3v-7.5Zm-18 3.75a.75.75 0 0 1 .75-.75h6a.75.75 0 0 1 0 1.5h-6a.75.75 0 0 1-.75-.75Zm.75 2.25a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 0-1.5h-3Z" clipRule="evenodd" />
                                    </svg>
                                </div>
                                <h4 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">2. Pay</h4>
                                <p className="text-gray-500 dark:text-gray-400">Pay securely via Razorpay with UPI, cards, or net banking</p>
                            </div>

                            {/* Step 3 */}
                            <div className="text-center p-6 rounded-2xl bg-gray-50 dark:bg-white/5 border border-gray-100 dark:border-white/10">
                                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-brand-primary">
                                        <path fillRule="evenodd" d="M8.603 3.799A4.49 4.49 0 0 1 12 2.25c1.357 0 2.573.6 3.397 1.549a4.49 4.49 0 0 1 3.498 1.307 4.491 4.491 0 0 1 1.307 3.497A4.49 4.49 0 0 1 21.75 12a4.49 4.49 0 0 1-1.549 3.397 4.491 4.491 0 0 1-1.307 3.497 4.491 4.491 0 0 1-3.497 1.307A4.49 4.49 0 0 1 12 21.75a4.49 4.49 0 0 1-3.397-1.549 4.49 4.49 0 0 1-3.498-1.306 4.491 4.491 0 0 1-1.307-3.498A4.49 4.49 0 0 1 2.25 12c0-1.357.6-2.573 1.549-3.397a4.49 4.49 0 0 1 1.307-3.497 4.49 4.49 0 0 1 3.497-1.307Zm7.007 6.387a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z" clipRule="evenodd" />
                                    </svg>
                                </div>
                                <h4 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">3. Collect</h4>
                                <p className="text-gray-500 dark:text-gray-400">Pick up your prints from the shop with your unique pickup code</p>
                            </div>
                        </div>
                    </div>

                    {/* For Shop Owners */}
                    <div>
                        <h3 className="text-2xl font-semibold text-center text-brand-primary mb-8">For Shop Owners</h3>
                        <div className="grid md:grid-cols-3 gap-8">
                            <div className="text-center p-6 rounded-2xl bg-gray-50 dark:bg-white/5 border border-gray-100 dark:border-white/10">
                                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-brand-primary">
                                        <path d="M5.223 2.25c-.497 0-.974.198-1.325.55l-1.3 1.298A3.75 3.75 0 0 0 7.5 9.75c.627.47 1.406.75 2.25.75.844 0 1.624-.28 2.25-.75.626.47 1.406.75 2.25.75.844 0 1.623-.28 2.25-.75a3.75 3.75 0 0 0 4.902-5.652l-1.3-1.299a1.875 1.875 0 0 0-1.325-.549H5.223Z" />
                                        <path fillRule="evenodd" d="M3 20.25v-8.755c1.42.674 3.08.673 4.5 0A5.234 5.234 0 0 0 9.75 12c.804 0 1.568-.182 2.25-.506a5.234 5.234 0 0 0 2.25.506c.804 0 1.567-.182 2.25-.506 1.42.674 3.08.675 4.5.001v8.755h.75a.75.75 0 0 1 0 1.5H2.25a.75.75 0 0 1 0-1.5H3Zm3-6a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-.75.75h-3a.75.75 0 0 1-.75-.75v-3Zm8.25-.75a.75.75 0 0 0-.75.75v5.25c0 .414.336.75.75.75h3a.75.75 0 0 0 .75-.75v-5.25a.75.75 0 0 0-.75-.75h-3Z" clipRule="evenodd" />
                                    </svg>
                                </div>
                                <h4 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Manage Orders</h4>
                                <p className="text-gray-500 dark:text-gray-400">View incoming orders, approve, and track printing status</p>
                            </div>

                            <div className="text-center p-6 rounded-2xl bg-gray-50 dark:bg-white/5 border border-gray-100 dark:border-white/10">
                                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-brand-primary">
                                        <path d="M12 7.5a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5Z" />
                                        <path fillRule="evenodd" d="M1.5 4.875C1.5 3.839 2.34 3 3.375 3h17.25c1.035 0 1.875.84 1.875 1.875v9.75c0 1.036-.84 1.875-1.875 1.875H3.375A1.875 1.875 0 0 1 1.5 14.625v-9.75ZM8.25 9.75a3.75 3.75 0 1 1 7.5 0 3.75 3.75 0 0 1-7.5 0ZM18.75 9a.75.75 0 0 0-.75.75v.008c0 .414.336.75.75.75h.008a.75.75 0 0 0 .75-.75V9.75a.75.75 0 0 0-.75-.75h-.008ZM4.5 9.75A.75.75 0 0 1 5.25 9h.008a.75.75 0 0 1 .75.75v.008a.75.75 0 0 1-.75.75H5.25a.75.75 0 0 1-.75-.75V9.75Z" clipRule="evenodd" />
                                        <path d="M2.25 18a.75.75 0 0 0 0 1.5c5.4 0 10.63.722 15.6 2.075 1.19.324 2.4-.558 2.4-1.82V18.75a.75.75 0 0 0-.75-.75H2.25Z" />
                                    </svg>
                                </div>
                                <h4 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Receive Payments</h4>
                                <p className="text-gray-500 dark:text-gray-400">Get paid directly to your bank account or UPI</p>
                            </div>

                            <div className="text-center p-6 rounded-2xl bg-gray-50 dark:bg-white/5 border border-gray-100 dark:border-white/10">
                                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-brand-primary">
                                        <path fillRule="evenodd" d="M2.25 13.5a8.25 8.25 0 0 1 8.25-8.25.75.75 0 0 1 .75.75v6.75H18a.75.75 0 0 1 .75.75 8.25 8.25 0 0 1-16.5 0Z" clipRule="evenodd" />
                                        <path fillRule="evenodd" d="M12.75 3a.75.75 0 0 1 .75-.75 8.25 8.25 0 0 1 8.25 8.25.75.75 0 0 1-.75.75h-7.5a.75.75 0 0 1-.75-.75V3Z" clipRule="evenodd" />
                                    </svg>
                                </div>
                                <h4 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Set Your Pricing</h4>
                                <p className="text-gray-500 dark:text-gray-400">Customize pricing for different paper types and color options</p>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* CTA Section */}
            <section className="py-16 px-4 bg-gradient-to-r from-red-500 to-red-600">
                <div className="max-w-4xl mx-auto text-center">
                    <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
                        Ready to simplify your printing?
                    </h2>
                    <p className="text-red-100 text-lg mb-8">
                        Join thousands of students and shop owners using EzyPrint today.
                    </p>
                    <Button
                        onClick={() => navigateTo('login')}
                        variant="secondary"
                        size="lg"
                        className="!px-10 !py-4 !text-lg !bg-white !text-red-600 hover:!bg-gray-100"
                    >
                        Sign Up Now — It's Free
                    </Button>
                </div>
            </section>
        </div>
    );
};

export default LandingPage;
