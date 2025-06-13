import React, { useState, useEffect, useRef } from 'react';
import { useAppContext } from '../../contexts/AppContext';
import NotificationList from './NotificationList';

const NotificationBell: React.FC = () => {
  const { getNotificationsForCurrentUser, markNotificationAsRead, currentUser } = useAppContext();
  const [isOpen, setIsOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  if (!currentUser) return null; 

  const currentNotifications = getNotificationsForCurrentUser();
  const unreadCount = currentNotifications.filter(n => !n.read).length;

  const toggleDropdown = () => {
    setIsOpen(!isOpen);
  };

  const handleMarkAsRead = (id: string) => {
    markNotificationAsRead(id);
  };
  
  const handleMarkAllAsRead = () => {
    currentNotifications.filter(n => !n.read).forEach(n => markNotificationAsRead(n.id));
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  return (
    <div className="relative" ref={bellRef}>
      <button
        onClick={toggleDropdown}
        className="p-2 rounded-full text-brand-lightText hover:text-brand-primary hover:bg-brand-secondaryLight focus:outline-none focus:bg-brand-secondaryLight relative transition-colors"
        aria-label="Notifications"
        title="Notifications"
      >
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.017 5.454 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 block h-5 w-5 transform rounded-full bg-brand-primary text-white text-xs flex items-center justify-center border-2 border-brand-secondary">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
      {isOpen && (
        <NotificationList
          notifications={currentNotifications}
          onMarkAsRead={handleMarkAsRead}
          onMarkAllAsRead={handleMarkAllAsRead}
          onClose={() => setIsOpen(false)}
        />
      )}
    </div>
  );
};

export default NotificationBell;