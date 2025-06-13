
import React from 'react';
import { NotificationMessage } from '../../types';
import NotificationItem from './NotificationItem';
import { Button } from '../common/Button';

interface NotificationListProps {
  notifications: NotificationMessage[];
  onMarkAsRead: (id: string) => void;
  onMarkAllAsRead: () => void;
  onClose: () => void;
}

const NotificationList: React.FC<NotificationListProps> = ({ notifications, onMarkAsRead, onMarkAllAsRead, onClose }) => {
  const unreadNotifications = notifications.filter(n => !n.read);
  // Sorting is now handled in getNotificationsForCurrentUser

  return (
    <div 
      className="absolute right-0 mt-2 w-80 sm:w-96 bg-brand-secondary border border-brand-muted/50 rounded-lg shadow-2xl overflow-hidden z-[60] 
                 transform transition-all duration-200 ease-out origin-top-right
                 opacity-100 scale-100" // Classes for when it's open
      // For a more controlled animation, you might manage these classes based on an internal 'isAnimatingOpen' state
      // For simplicity, Tailwind's default transition applied on mount/unmount will work if parent controls visibility.
    >
      <div className="p-3 flex justify-between items-center border-b border-brand-muted/30 bg-brand-secondaryLight/50">
        <h6 className="font-semibold text-brand-primary">Notifications</h6>
        {unreadNotifications.length > 0 && (
           <Button onClick={onMarkAllAsRead} variant="ghost" size="sm" className="text-xs !py-1 !px-2">Mark all as read</Button>
        )}
      </div>
      {notifications.length === 0 ? (
        <p className="text-brand-lightText text-center py-10 px-4 text-sm">You're all caught up! No new notifications.</p>
      ) : (
        <div className="max-h-96 overflow-y-auto divide-y divide-brand-muted/20">
          {notifications.map(notification => (
            <NotificationItem 
              key={notification.id} 
              notification={notification} 
              onMarkAsRead={onMarkAsRead} 
            />
          ))}
        </div>
      )}
       <div className="p-2 border-t border-brand-muted/30 bg-brand-secondaryLight/50 text-center">
          <Button onClick={onClose} variant="secondary" size="sm" fullWidth>Close Notifications</Button>
      </div>
    </div>
  );
};

export default NotificationList;
