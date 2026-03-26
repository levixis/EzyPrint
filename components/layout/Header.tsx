
import React from 'react';
import { User } from '../../types';
import NotificationBell from '../notifications/NotificationBell';
import { Button } from '../common/Button';
import { AppView } from '../../types';
import { useTheme } from '../../contexts/ThemeContext'; // Import useTheme

import { useRef } from 'react'; // Import useRef
import { useGSAP } from '@gsap/react'; // Import useGSAP
import gsap from 'gsap'; // Import gsap

interface HeaderProps {
  currentUser: User | null;
  onLogout: () => void;
  navigateTo: (view: AppView) => void; // Added navigateTo prop
}

const EzyPrintLogoIcon: React.FC = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-brand-primary">
    <path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7H5v-1c0-.55.45-1 1-1h12c.55 0 1 .45 1 1v1zm-1-9H6v4h12V3z" />
    <path fill="none" d="M0 0h24v24H0z" />
  </svg>
);


const Header: React.FC<HeaderProps> = ({ currentUser, onLogout, navigateTo }) => {
  const { theme, toggleTheme } = useTheme(); // Use theme hook
  const headerRef = useRef<HTMLElement>(null);

  useGSAP(() => {
    gsap.from(headerRef.current, {
      y: -50,
      opacity: 0,
      duration: 1,
      ease: "elastic.out(1, 0.75)",
      delay: 0.2
    });
  }, { scope: headerRef });

  const handleLogoClick = () => {
    if (currentUser) {
      if (currentUser.type === 'ADMIN') {
        navigateTo('adminDashboard');
      } else {
        navigateTo(currentUser.type === 'STUDENT' ? 'studentDashboard' : 'shopDashboard');
      }
    } else {
      navigateTo('landing');
    }
  };

  return (
    <header ref={headerRef} className="fixed top-4 left-0 right-0 z-50 px-4 flex justify-center">
      <div className="container max-w-5xl mx-auto glass rounded-full shadow-lg border border-white/20 dark:border-white/10 px-6 py-3 flex justify-between items-center transition-all duration-300">
        <button onClick={handleLogoClick} className="flex items-center space-x-2 focus:outline-none group" aria-label="Go to dashboard or login">
          <div className="transform group-hover:scale-110 transition-transform duration-200">
            <EzyPrintLogoIcon />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              <span className="text-brand-text dark:text-brand-dark-text">EZY</span><span className="text-brand-primary">PRINT</span>
            </h1>
          </div>
        </button>
        <div className="flex items-center space-x-2 sm:space-x-4">
          {/* Student Pass Button - Upsell */}
          {currentUser?.type === 'STUDENT' && (
            currentUser.hasStudentPass ? (
              <button
                onClick={() => navigateTo('getPass')}
                className="hidden sm:flex items-center space-x-2 px-3 py-1.5 rounded-full bg-gradient-to-r from-yellow-400/20 to-yellow-600/20 border border-yellow-500/50 text-yellow-500 font-bold text-xs uppercase tracking-wider shadow-[0_0_10px_rgba(234,179,8,0.2)] hover:from-yellow-400/30 hover:to-yellow-600/30 transition-all cursor-pointer"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.007 5.404.433c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.433 2.082-5.006z" clipRule="evenodd" />
                </svg>
                <span>Premium Member</span>
              </button>
            ) : (
              <Button
                onClick={() => navigateTo('getPass')}
                variant="accent"
                size="sm"
                className="hidden sm:flex items-center !bg-gradient-to-r !from-yellow-400 !to-yellow-600 hover:!from-yellow-500 hover:!to-yellow-700 !text-black font-extrabold px-4 shadow-[0_4px_14px_0_rgba(250,204,21,0.39)] hover:shadow-[0_6px_20px_rgba(250,204,21,0.23)] hover:-translate-y-0.5 transition-all transform"
                leftIcon={
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-black">
                    <path fillRule="evenodd" d="M9 4.5a.75.75 0 0 1 .721.544l.813 2.846a3.75 3.75 0 0 0 2.576 2.576l2.846.813a.75.75 0 0 1 0 1.442l-2.846.813a3.75 3.75 0 0 0-2.576 2.576l-.813 2.846a.75.75 0 0 1-1.442 0l-.813-2.846a3.75 3.75 0 0 0-2.576-2.576l-2.846-.813a.75.75 0 0 1 0-1.442l2.846-.813a3.75 3.75 0 0 0 2.576-2.576l.813-2.846A.75.75 0 0 1 9 4.5ZM1.5 9.75a.75.75 0 0 1 .156-.473l2.846-.813a.75.75 0 0 1 1.442 0l.813 2.846a.75.75 0 0 1-.473.91l-3.328 1.408a.75.75 0 0 1-.956-.566l-.5-3.312Zm7.768 7.768a.75.75 0 0 1 .473-.91l3.328-1.408a.75.75 0 0 1 .956.566l.5 3.312a.75.75 0 0 1-.156.473l-2.846.813a.75.75 0 0 1-1.442 0l-.813-2.846Z" clipRule="evenodd" />
                  </svg>
                }
              >
                Get Pass
              </Button>
            )
          )}
          <button
            onClick={toggleTheme}
            className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors focus:outline-none text-brand-lightText dark:text-brand-dark-textSecondary hover:text-brand-primary dark:hover:text-brand-primary"
            aria-label="Toggle Dark Mode"
          >
            {theme === 'light' ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                <path d="M12 2.25a.75.75 0 01.75.75v2.25a.75.75 0 01-1.5 0V3a.75.75 0 01.75-.75zM7.5 12a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM18.894 6.166a.75.75 0 00-1.06-1.06l-1.591 1.59a.75.75 0 101.06 1.061l1.591-1.59zM21.75 12a.75.75 0 01-.75.75h-2.25a.75.75 0 010-1.5H21a.75.75 0 01.75.75zM17.834 18.894a.75.75 0 001.06-1.06l-1.59-1.591a.75.75 0 10-1.061 1.06l1.59 1.591zM12 18a.75.75 0 01.75.75V21a.75.75 0 01-1.5 0v-2.25A.75.75 0 0112 18zM7.758 17.303a.75.75 0 00-1.061-1.06l-1.591 1.59a.75.75 0 001.06 1.061l1.591-1.59zM6 12a.75.75 0 01-.75.75H3a.75.75 0 010-1.5h2.25A.75.75 0 016 12zM6.697 7.757a.75.75 0 001.06-1.06l-1.59-1.591a.75.75 0 00-1.061 1.06l1.59 1.591z" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M9.528 1.718a.75.75 0 01.162.819A8.97 8.97 0 009 6a9 9 0 009 9 8.97 8.97 0 003.463-.69.75.75 0 01.981.98 10.503 10.503 0 01-9.694 6.46c-5.799 0-10.5-4.701-10.5-10.5 0-4.368 2.667-8.112 6.46-9.694a.75.75 0 01.818.162z" clipRule="evenodd" />
              </svg>
            )}
          </button>

          {currentUser && (
            <>
              <NotificationBell />
              <div className="text-sm text-brand-lightText hidden sm:block">
                <span className="font-semibold text-brand-text dark:text-brand-dark-text">{currentUser.name || currentUser.type.replace('_', ' ')}</span>
                {currentUser.type === 'ADMIN' && (
                  <span className="ml-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-gradient-to-r from-violet-500 to-purple-600 text-white shadow-sm">Admin</span>
                )}
              </div>
              <Button
                onClick={onLogout}
                variant="danger"
                size="sm"
                className="rounded-full px-4"
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
              className="rounded-full"
            >
              Contact
            </Button>
          )}
        </div>
      </div>
    </header>
  );
};

export default Header;
