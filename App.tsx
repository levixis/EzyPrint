
import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { initMobile } from './utils/mobile';
import { UserType, AppView } from './types';
import Header from './components/layout/Header';
import StudentDashboard from './components/student/StudentDashboard';
import ShopDashboard from './components/shop/ShopDashboard';
import AdminDashboard from './components/admin/AdminDashboard';
import LoginPage from './components/auth/LoginPage';
import { useAppContext } from './contexts/AppContext';
import { enableNetwork, db } from './firebase';
import { Spinner } from './components/common/Spinner';
import { ThemeProvider } from './contexts/ThemeContext';

// Static Page Imports
import PrivacyPolicyPage from './components/static/PrivacyPolicyPage';
import TermsConditionsPage from './components/static/TermsConditionsPage';
import RefundPolicyPage from './components/static/RefundPolicyPage';
import ShippingDeliveryPolicyPage from './components/static/ShippingDeliveryPolicyPage';
import ContactPage from './components/static/ContactPage';
import StudentPassPage from './components/student/StudentPassPage';
import LandingPage from './components/LandingPage';


// Fallback component for shop dashboard loading — prevents infinite spinner for new shopkeepers
// whose shop data hasn't been picked up by onSnapshot yet.
const ShopLoadingFallback: React.FC = () => {
  const [timedOut, setTimedOut] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 8_000);
    return () => clearTimeout(timer);
  }, []);

  const handleRetry = () => {
    if (retryCount >= 1) {
      // Second retry — reload page. The onSnapshot listener may be dead,
      // and a full reload re-initializes Firebase cleanly (guaranteed fix).
      window.location.reload();
      return;
    }
    // First retry — kick Firestore to reconnect, then wait for the
    // self-healing shops listener to pick up data. If shops state updates,
    // the parent component will auto-switch from Fallback to ShopDashboard.
    setRetryCount(1);
    setTimedOut(false);
    enableNetwork(db).catch(() => {});
    setTimeout(() => setTimedOut(true), 5000);
  };

  if (!timedOut) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh]">
        <Spinner size="lg" />
        <p className="mt-4 text-brand-lightText">Loading shop data...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] text-center px-6">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-16 h-16 text-amber-400 mb-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
      </svg>
      <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Shop data is taking longer than expected</h3>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">This can happen when your shop was just created or your network is slow.</p>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">If you just registered, your shop may be pending admin approval.</p>
      <button
        onClick={handleRetry}
        className="px-6 py-2.5 rounded-lg bg-brand-primary text-white font-medium hover:bg-brand-primaryDark transition-colors"
      >
        {retryCount >= 1 ? 'Reload Page' : 'Try Again'}
      </button>
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
  const { currentUser, logoutUser, isLoadingAuth, pendingFirebaseProfileCreationUser, isLoadingShops, getShopById, currentView, navigateTo, goBack } = useAppContext();

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
      console.warn('[App] Back button handler not available:', err);
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
      } else if (currentUser.type === UserType.SHOP_OWNER && currentUser.shopId) {
        // Don't wait for shop data to load — the dashboard handles its own loading state.
        // Waiting for getShopById() caused new shopkeepers to get stuck on the login page
        // because the onSnapshot hadn't picked up their newly created shop yet.
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
        if (currentUser?.type === UserType.SHOP_OWNER && currentUser.shopId) {
          const shop = getShopById(currentUser.shopId);
          if (isLoadingShops || !shop) {
            // Use the fallback component instead of a plain spinner
            // It handles timeouts and retry for new shopkeepers
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
        {renderContent()}
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

