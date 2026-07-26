
import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { initMobile } from './utils/mobile';
import { UserType, AppView, ShopProfile } from './types';
import Header from './components/layout/Header';
import { useAppContext } from './contexts/AppContext';
import { enableNetwork, db } from './firebase';
import { Spinner } from './components/common/Spinner';
import { ThemeProvider } from './contexts/ThemeContext';

const StudentDashboard = lazy(() => import('./components/student/StudentDashboard'));
const ShopDashboard = lazy(() => import('./components/shop/ShopDashboard'));
const AdminDashboard = lazy(() => import('./components/admin/AdminDashboard'));
const LoginPage = lazy(() => import('./components/auth/LoginPage'));
const PrivacyPolicyPage = lazy(() => import('./components/static/PrivacyPolicyPage'));
const TermsConditionsPage = lazy(() => import('./components/static/TermsConditionsPage'));
const RefundPolicyPage = lazy(() => import('./components/static/RefundPolicyPage'));
const ShippingDeliveryPolicyPage = lazy(() => import('./components/static/ShippingDeliveryPolicyPage'));
const ContactPage = lazy(() => import('./components/static/ContactPage'));
const StudentPassPage = lazy(() => import('./components/student/StudentPassPage'));
const LandingPage = lazy(() => import('./components/LandingPage'));


// Fallback component for shop dashboard loading — prevents infinite spinner for new shopkeepers
// whose shop data hasn't been picked up by onSnapshot yet.
const ShopLoadingFallback: React.FC = () => {
  const [timedOut, setTimedOut] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (!timedOut) {
      timer = setTimeout(() => setTimedOut(true), 8_000);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [timedOut, retryCount]);



  if (!timedOut) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh]">
        <Spinner size="lg" />
        <p className="mt-4 text-brand-lightText">Loading shop data...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] text-center px-4">
      <Spinner size="lg" />
      <p className="mt-4 text-brand-lightText">Loading your shop dashboard...</p>
      {timedOut && (
        <div className="mt-6 space-y-3 max-w-sm">
          <p className="text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg border border-amber-200 dark:border-amber-800">
            ⚠️ Taking longer than expected. This can happen for new shops.
          </p>
          <button
            onClick={() => { setRetryCount(c => c + 1); setTimedOut(false); enableNetwork(db); }}
            className="px-4 py-2 text-sm font-medium text-brand-primary bg-brand-primary/10 hover:bg-brand-primary/20 rounded-lg transition-colors"
          >
            🔄 Retry ({retryCount})
          </button>
        </div>
      )}
    </div>
  );
};

// Banner shown when a shopkeeper signs in and their shop is archived.
// They can request reactivation from here.
const ArchivedShopBanner: React.FC<{ shop: ShopProfile }> = ({ shop }) => {
  const { submitReactivationRequest, logoutUser } = useAppContext();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const handleRequestReactivation = async () => {
    setIsSubmitting(true);
    setErrorMsg('');
    const result = await submitReactivationRequest(shop.id, shop.name);
    setIsSubmitting(false);
    if (result.success) {
      setSubmitted(true);
    } else {
      if (result.message?.includes('already pending')) {
        setSubmitted(true);
      } else {
        setErrorMsg(result.message || 'Failed to submit request.');
      }
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] text-center px-4">
      <div className="max-w-md w-full bg-white dark:bg-zinc-900 rounded-2xl shadow-lg border border-gray-200 dark:border-zinc-700 p-8 space-y-5">
        <div className="w-20 h-20 mx-auto bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-10 h-10 text-amber-600 dark:text-amber-400">
            <path d="M3.375 3C2.339 3 1.5 3.84 1.5 4.875v.75c0 1.036.84 1.875 1.875 1.875h17.25c1.035 0 1.875-.84 1.875-1.875v-.75C22.5 3.839 21.66 3 20.625 3H3.375Z" />
            <path fillRule="evenodd" d="m3.087 9 .54 9.176A3 3 0 0 0 6.62 21h10.757a3 3 0 0 0 2.995-2.824L20.913 9H3.087Zm6.163 3.75A.75.75 0 0 1 10 12h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1-.75-.75Z" clipRule="evenodd" />
          </svg>
        </div>

        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Shop Archived</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Your shop <strong className="text-gray-900 dark:text-white">"{shop.name}"</strong> has been archived by the admin.
          You can request reactivation below.
        </p>

        {errorMsg && (
          <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg border border-red-200 dark:border-red-800">
            {errorMsg}
          </p>
        )}

        {submitted ? (
          <div className="bg-emerald-50 dark:bg-emerald-900/20 px-4 py-3 rounded-xl border border-emerald-200 dark:border-emerald-800">
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
              ✅ Reactivation request submitted! The admin will review it shortly. You'll receive a notification once it's resolved.
            </p>
          </div>
        ) : (
          <button
            onClick={handleRequestReactivation}
            disabled={isSubmitting}
            className="w-full px-6 py-3 text-sm font-semibold text-white bg-gradient-to-r from-brand-primary to-red-600 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isSubmitting ? 'Submitting Request...' : '📨 Request Reactivation'}
          </button>
        )}

        <button
          onClick={logoutUser}
          className="w-full px-4 py-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        >
          Sign Out
        </button>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
};

// Internal component to use hooks inside Provider if needed, but mostly just structured cleanly.
const AppContent: React.FC = () => {
  const { currentUser, logoutUser, isLoadingAuth, pendingFirebaseProfileCreationUser, isLoadingShops, getShopById, currentView, navigateTo, goBack, archivedShopForCurrentUser } = useAppContext();

  // Track whether we've done the initial redirect after auth resolves
  const hasRedirected = useRef(false);

  // Valid views for each user type - these views don't require redirect
  const staticPages: AppView[] = ['privacy', 'terms', 'refund', 'shipping', 'contact'];

  // Initialize mobile platform features (status bar, splash screen, etc.)
  useEffect(() => { initMobile(); }, []);

  // Handle Android hardware back button
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let cleanup: (() => void) | undefined;

    import('@capacitor/app').then(({ App }) => {
      const listener = App.addListener('backButton', () => {
        // If we have navigation history, go back one step
        // The 'landing' and dashboard views are "root" views — exit app from there
        const rootViews: AppView[] = ['landing', 'login', 'studentDashboard', 'shopDashboard', 'adminDashboard'];
        if (!rootViews.includes(currentView)) {
          goBack();
        } else {
          // On root views, let the app minimize (default Android behavior)
          App.minimizeApp();
        }
      });

      listener.then(handle => {
        cleanup = () => handle.remove();
      });
    }).catch(err => {
      void err;
    });

    return () => {
      cleanup?.();
    };
  }, [currentView, goBack]);

  useEffect(() => {
    // Don't do anything while auth is still loading
    if (isLoadingAuth) return;

    // Reset redirect flag when user changes (login/logout)
    if (!currentUser) {
      hasRedirected.current = false;
    }

    if (!currentUser || pendingFirebaseProfileCreationUser) {
      // Not logged in - only redirect if on a protected view
      if (!['landing', 'login', ...staticPages].includes(currentView)) {
        navigateTo('landing');
      }
      return;
    }

    // User is logged in - redirect from landing/login to their dashboard (once)
    if (currentView === 'login' || currentView === 'landing') {
      if (currentUser.type === UserType.ADMIN) {
        navigateTo('adminDashboard');
        hasRedirected.current = true;
      } else if (currentUser.type === UserType.STUDENT && !isLoadingShops) {
        navigateTo('studentDashboard');
        hasRedirected.current = true;
      } else if (currentUser.type === UserType.SHOP_OWNER) {
        // Navigate to shop dashboard even if shopId is missing — the dashboard
        // handles its own loading/recovery state for corrupt profiles.
        navigateTo('shopDashboard');
        hasRedirected.current = true;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, isLoadingAuth, pendingFirebaseProfileCreationUser, isLoadingShops]);

  const handleLogout = () => {
    logoutUser();
    navigateTo('landing');
  };


  const renderContent = () => {
    // Show spinner while auth is resolving
    if (isLoadingAuth) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[70vh]">
          <Spinner size="lg" />
          <p className="mt-4 text-brand-lightText">Verifying account...</p>
        </div>
      );
    }

    switch (currentView) {
      case 'landing':
        return <LandingPage />;
      case 'login':
        return <LoginPage />;
      case 'adminDashboard':
        if (currentUser?.type === UserType.ADMIN) {
          return <AdminDashboard />;
        }
        return <LoginPage />;
      case 'studentDashboard':
        if (currentUser?.type === UserType.STUDENT) {
          if (isLoadingShops) {
            return (
              <div className="flex flex-col items-center justify-center min-h-[70vh]">
                <Spinner size="lg" />
                <p className="mt-4 text-brand-lightText">Loading available shops...</p>
              </div>
            );
          }
          return <StudentDashboard userId={currentUser.id} onNavigateToPass={() => navigateTo('getPass')} />;
        }
        return <LoginPage />;
      case 'shopDashboard':
        if (currentUser?.type === UserType.SHOP_OWNER) {
          // If shopId is missing, show a recovery screen instead of LoginPage
          if (!currentUser.shopId) {
            return (
              <div className="flex flex-col items-center justify-center min-h-[70vh] text-center px-4">
                <div className="max-w-md w-full bg-white dark:bg-zinc-900 rounded-2xl shadow-lg border border-gray-200 dark:border-zinc-700 p-8 space-y-5">
                  <div className="w-20 h-20 mx-auto bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-10 h-10 text-amber-600 dark:text-amber-400">
                      <path fillRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003ZM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75Zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Profile Issue Detected</h2>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Your account is missing shop data. This may happen if your shop registration is still being processed.
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-500">
                    Please contact admin support for assistance.
                  </p>
                  <button
                    onClick={() => { logoutUser(); navigateTo('landing'); }}
                    className="w-full px-4 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors border border-gray-200 dark:border-zinc-700 rounded-lg"
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            );
          }
          // Check if shop is archived — show reactivation banner instead of dashboard
          if (archivedShopForCurrentUser) {
            return <ArchivedShopBanner shop={archivedShopForCurrentUser} />;
          }
          const shop = getShopById(currentUser.shopId);
          if (isLoadingShops || !shop) {
            return <ShopLoadingFallback />;
          }
          return <ShopDashboard shopId={currentUser.shopId} />;
        }
        return <LoginPage />;
      case 'privacy':
        return <PrivacyPolicyPage />;
      case 'terms':
        return <TermsConditionsPage />;
      case 'refund':
        return <RefundPolicyPage />;
      case 'shipping':
        return <ShippingDeliveryPolicyPage />;
      case 'contact':
        return <ContactPage />;
      case 'getPass':
        if (currentUser?.type === UserType.STUDENT) {
          return <StudentPassPage />;
        }
        return <LoginPage />;
      default:
        return <LandingPage />;
    }
  };

  const FooterLink: React.FC<{ view: AppView; children: React.ReactNode }> = ({ view, children }) => (
    <button onClick={() => navigateTo(view)} className="hover:text-brand-primary transition-colors duration-150 focus:outline-none focus:text-brand-primary">
      {children}
    </button>
  );

  return (
    <div className="min-h-screen flex flex-col bg-brand-bg text-brand-text dark:bg-brand-dark-bg dark:text-brand-dark-text selection:bg-brand-primary selection:text-brand-secondary transition-colors duration-300">
      <Header currentUser={currentUser} onLogout={handleLogout} navigateTo={navigateTo} />
      <main className="flex-grow container mx-auto px-4 py-8 pb-4">
        <Suspense fallback={
          <div className="flex flex-col items-center justify-center min-h-[70vh]">
            <Spinner size="lg" />
            <p className="mt-4 text-brand-lightText">Loading page...</p>
          </div>
        }>
          {renderContent()}
        </Suspense>
      </main>
      <footer className="text-center py-6 px-4 text-sm text-gray-600 dark:text-gray-400 border-t border-gray-200 dark:border-zinc-700 transition-colors duration-300">
        <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 mb-2">
          <FooterLink view="privacy">Privacy Policy</FooterLink>
          <span>&bull;</span>
          <FooterLink view="terms">Terms &amp; Conditions</FooterLink>
          <span>&bull;</span>
          <FooterLink view="refund">Cancellation &amp; Refund</FooterLink>
          <span>&bull;</span>
          <FooterLink view="shipping">Service Delivery</FooterLink>
          <span>&bull;</span>
          <FooterLink view="contact">Contact Us</FooterLink>
        </div>
        EzyPrint &copy; {new Date().getFullYear()} - Made by Levixis
      </footer>
    </div>
  );
};

export default App;
