

import React, { useState, useEffect } from 'react'; // Added useEffect
import { UserType } from './types'; 
import Header from './components/layout/Header';
import StudentDashboard from './components/student/StudentDashboard';
import ShopDashboard from './components/shop/ShopDashboard';
import LoginPage from './components/auth/LoginPage';
import { useAppContext } from './contexts/AppContext';
import { Spinner } from './components/common/Spinner';

// Static Page Imports
import PrivacyPolicyPage from './components/static/PrivacyPolicyPage';
import TermsConditionsPage from './components/static/TermsConditionsPage';
import RefundPolicyPage from './components/static/RefundPolicyPage';
import ShippingDeliveryPolicyPage from './components/static/ShippingDeliveryPolicyPage';
import ContactPage from './components/static/ContactPage';

export type AppView =
  | 'login'
  | 'studentDashboard'
  | 'shopDashboard'
  | 'privacy'
  | 'terms'
  | 'refund'
  | 'shipping'
  | 'contact';

const App: React.FC = () => {
  const { currentUser, logoutUser, isLoadingAuth, pendingFirebaseProfileCreationUser, isLoadingShops, getShopById } = useAppContext(); // Added getShopById
  const [currentView, setCurrentView] = useState<AppView>('login'); 

  useEffect(() => {
    if (!isLoadingAuth) { 
      if (!currentUser || pendingFirebaseProfileCreationUser) {
        if (currentView !== 'login') setCurrentView('login');
      } else if (currentUser.type === UserType.STUDENT) {
        if (!isLoadingShops) {
          if (currentView !== 'studentDashboard') setCurrentView('studentDashboard');
        } else {
           if (currentView !== 'studentDashboard' && currentView !== 'login') {
             setCurrentView('studentDashboard');
          }
        }
      } else if (currentUser.type === UserType.SHOP_OWNER && currentUser.shopId) {
        // For shop owner, proceed only if shops are loaded AND their specific shop is found
        if (!isLoadingShops && getShopById(currentUser.shopId)) { 
          if (currentView !== 'shopDashboard') setCurrentView('shopDashboard');
        } else {
          // Shops are still loading OR this specific shop isn't found yet.
          // If not already on login or shopDashboard, set to shopDashboard to show spinner.
          if (currentView !== 'shopDashboard' && currentView !== 'login') {
             setCurrentView('shopDashboard');
          }
        }
      } else {
        if (currentView !== 'login') setCurrentView('login');
      }
    }
  }, [currentUser, isLoadingAuth, pendingFirebaseProfileCreationUser, isLoadingShops, currentView, getShopById]); // Added getShopById to dependencies

  const navigateTo = (view: AppView) => {
    setCurrentView(view);
    window.scrollTo(0, 0); 
  };

  const handleLogout = () => {
    logoutUser();
    setCurrentView('login'); 
  };


  const renderContent = () => {
    const isAuthSpinnerNeeded = isLoadingAuth && (!currentUser || currentView === 'login');
    
    // Spinner for Shop Owner: show if general shops are loading OR if their specific shop isn't found yet
    const isShopDataSpinnerNeededForOwner = 
      currentUser?.type === UserType.SHOP_OWNER && 
      currentUser.shopId && // Ensure shopId exists to attempt getShopById
      (currentView === 'shopDashboard' || (currentView === 'login' && !pendingFirebaseProfileCreationUser)) && 
      (isLoadingShops || !getShopById(currentUser.shopId)); 
    
    const isShopDataSpinnerNeededForStudent = 
      currentUser?.type === UserType.STUDENT &&
      currentView === 'studentDashboard' && 
      isLoadingShops;


    if (isAuthSpinnerNeeded || isShopDataSpinnerNeededForOwner || isShopDataSpinnerNeededForStudent) {
      let spinnerText = "Loading EzyPrint...";
      if (isShopDataSpinnerNeededForOwner) spinnerText = "Loading shop data...";
      else if (isShopDataSpinnerNeededForStudent) spinnerText = "Loading available shops...";
      else if (isAuthSpinnerNeeded) spinnerText = "Verifying account...";


      return (
        <div className="flex flex-col items-center justify-center min-h-[70vh]">
          <Spinner size="lg" />
          <p className="mt-4 text-brand-lightText">
            {spinnerText}
          </p>
        </div>
      );
    }

    switch (currentView) {
      case 'login':
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
          return <StudentDashboard userId={currentUser.id} />;
        }
        navigateTo('login'); 
        return null;
      case 'shopDashboard':
        if (currentUser?.type === UserType.SHOP_OWNER && currentUser.shopId) {
          // Spinner safeguard if caught by currentView switch but main spinner logic somehow missed it
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
        navigateTo('login'); 
        return null;
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
      default:
        if (!isLoadingAuth && currentUser && !pendingFirebaseProfileCreationUser) {
            if (currentUser.type === UserType.STUDENT) {
                if (!isLoadingShops || currentView === 'studentDashboard') {
                    navigateTo('studentDashboard');
                } else {
                    setCurrentView('studentDashboard'); 
                }
            } else if (currentUser.type === UserType.SHOP_OWNER && currentUser.shopId) { // Ensure shopId exists
                 if (!isLoadingShops && getShopById(currentUser.shopId)) { // Check specific shop is loaded
                     navigateTo('shopDashboard');
                 } else {
                     setCurrentView('shopDashboard'); // Trigger spinner
                 }
            } else {
                navigateTo('login'); 
            }
        } else if (!isLoadingAuth) { 
            navigateTo('login');
        }
        return null;
    }
  };

  const FooterLink: React.FC<{ view: AppView; children: React.ReactNode }> = ({ view, children }) => (
    <button onClick={() => navigateTo(view)} className="hover:text-brand-primary transition-colors duration-150 focus:outline-none focus:text-brand-primary">
      {children}
    </button>
  );

  return (
    <div className="min-h-screen flex flex-col bg-brand-bg text-brand-text selection:bg-brand-primary selection:text-white">
      <Header currentUser={currentUser} onLogout={handleLogout} navigateTo={navigateTo} />
      <main className="flex-grow container mx-auto px-4 py-8">
        {renderContent()}
      </main>
      <footer className="text-center py-6 text-sm text-brand-muted border-t border-brand-secondaryLight">
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
