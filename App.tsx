


import React, { useEffect, useRef } from 'react';
import { initMobile } from './utils/mobile';
import { UserType, AppView } from './types';
import Header from './components/layout/Header';
import StudentDashboard from './components/student/StudentDashboard';
import ShopDashboard from './components/shop/ShopDashboard';
import AdminDashboard from './components/admin/AdminDashboard';
import LoginPage from './components/auth/LoginPage';
import { useAppContext } from './contexts/AppContext';
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



const App: React.FC = () => {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
};

// Internal component to use hooks inside Provider if needed, but mostly just structured cleanly.
const AppContent: React.FC = () => {
  const { currentUser, logoutUser, isLoadingAuth, pendingFirebaseProfileCreationUser, isLoadingShops, getShopById, currentView, navigateTo } = useAppContext();

  // Track whether we've done the initial redirect after auth resolves
  const hasRedirected = useRef(false);

  // Valid views for each user type - these views don't require redirect
  const staticPages: AppView[] = ['privacy', 'terms', 'refund', 'shipping', 'contact'];

  // Initialize mobile platform features (status bar, splash screen, etc.)
  useEffect(() => { initMobile(); }, []);

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
      } else if (currentUser.type === UserType.SHOP_OWNER && currentUser.shopId && !isLoadingShops && getShopById(currentUser.shopId)) {
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
          if (isLoadingShops || !getShopById(currentUser.shopId)) {
            return (
              <div className="flex flex-col items-center justify-center min-h-[70vh]">
                <Spinner size="lg" />
                <p className="mt-4 text-brand-lightText">Loading shop data...</p>
              </div>
            );
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
      <main className="flex-grow container mx-auto px-4 py-8">
        {renderContent()}
      </main>
      <footer className="text-center py-6 text-sm text-gray-600 dark:text-gray-400 border-t border-gray-200 dark:border-zinc-700 transition-colors duration-300">
        <div className="flex justify-center space-x-4 mb-2">
          <FooterLink view="privacy">Privacy Policy</FooterLink>
          <span>&bull;</span>
          <FooterLink view="terms">Terms & Conditions</FooterLink>
          <span>&bull;</span>
          <FooterLink view="refund">Cancellation & Refund</FooterLink>
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
