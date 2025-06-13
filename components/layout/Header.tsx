
import React from 'react';
import { User } from '../../types';
import NotificationBell from '../notifications/NotificationBell';
import { Button } from '../common/Button';
import { AppView } from '../../App'; // Import AppView type

interface HeaderProps {
  currentUser: User | null;
  onLogout: () => void;
  navigateTo: (view: AppView) => void; // Added navigateTo prop
}

const EzyPrintLogoIcon: React.FC = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-10 h-10 text-brand-primary">
    <path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7H5v-1c0-.55.45-1 1-1h12c.55 0 1 .45 1 1v1zm-1-9H6v4h12V3z"/>
    <path fill="none" d="M0 0h24v24H0z"/>
  </svg>
);


const Header: React.FC<HeaderProps> = ({ currentUser, onLogout, navigateTo }) => {
  const handleLogoClick = () => {
    if (currentUser) {
      navigateTo(currentUser.type === 'STUDENT' ? 'studentDashboard' : 'shopDashboard');
    } else {
      navigateTo('login');
    }
  };
  
  return (
    <header className="bg-brand-secondary/90 backdrop-blur-md shadow-lg sticky top-0 z-50 border-b border-brand-secondaryLight">
      <div className="container mx-auto px-4 py-3 flex justify-between items-center">
        <button onClick={handleLogoClick} className="flex items-center space-x-2 focus:outline-none rounded-md focus:ring-2 focus:ring-brand-primary focus:ring-offset-2 focus:ring-offset-brand-secondary" aria-label="Go to dashboard or login">
          <EzyPrintLogoIcon />
          <div>
            <h1 className="text-3xl font-bold">
              <span className="text-brand-text">EZY</span><span className="text-brand-primary">PRINT</span>
            </h1>
            <p className="text-xs text-brand-primaryDark font-semibold tracking-wider -mt-1">PAY PRINT COLLECT</p>
          </div>
        </button>
        <div className="flex items-center space-x-4">
          {currentUser && (
            <>
              <NotificationBell />
              <div className="text-sm text-brand-lightText hidden sm:block">
                Logged in as: <span className="font-semibold text-brand-text">{currentUser.name || currentUser.type.replace('_', ' ')}</span>
              </div>
              <Button
                onClick={onLogout}
                variant="danger"
                size="sm"
              >
                Logout
              </Button>
            </>
          )}
          {!currentUser && ( // Example: Show contact link if not logged in
             <Button
                onClick={() => navigateTo('contact')}
                variant="ghost"
                size="sm"
              >
                Contact Us
              </Button>
          )}
        </div>
      </div>
    </header>
  );
};

export default Header;
