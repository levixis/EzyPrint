
import React, { useState } from 'react';
import FileUploadForm from './FileUploadForm';
import StudentOrderList from './StudentOrderList';
import { useAppContext, isStudentPassActive, getStudentPassDaysRemaining, getStudentPassExpiryDate } from '../../contexts/AppContext';
import { Card } from '../common/Card';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import TicketForm from '../tickets/TicketForm';
import TicketList from '../tickets/TicketList';

interface StudentDashboardProps {
  userId: string;
  onNavigateToPass: () => void;
}

const StudentDashboard: React.FC<StudentDashboardProps> = ({ userId, onNavigateToPass }) => {
  const { getOrdersForCurrentUser, currentUser, isLoadingShops, deleteOwnStudentAccount, tickets } = useAppContext();
  const studentOrders = getOrdersForCurrentUser();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showTicketForm, setShowTicketForm] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    await deleteOwnStudentAccount();
    setIsDeleting(false);
    setShowDeleteConfirm(false);
  };

  // Student Pass state
  const passActive = isStudentPassActive(
    currentUser?.hasStudentPass,
    currentUser?.studentPassActivatedAt
  );
  const daysRemaining = getStudentPassDaysRemaining(currentUser?.studentPassActivatedAt);
  const expiryDate = getStudentPassExpiryDate(currentUser?.studentPassActivatedAt);
  const hasExpiredPass = currentUser?.studentPassActivatedAt && !passActive;

  return (
    <div className="space-y-8 pt-28">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-3xl font-bold text-brand-text dark:text-brand-dark-text">Welcome, {currentUser?.name || 'Student'}!</h2>
        <button
          onClick={() => setIsSettingsModalOpen(true)}
          className="flex-shrink-0 p-2.5 rounded-xl bg-gray-100 dark:bg-zinc-800 hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-600 dark:text-gray-400 transition-colors"
          title="Settings"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
        </button>
      </div>

      {/* Expired Pass Renewal Banner */}
      {hasExpiredPass && (
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-yellow-50 to-orange-50 dark:from-yellow-900/20 dark:to-orange-900/20 border border-yellow-200 dark:border-yellow-800/50 p-5">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center shadow-lg shadow-yellow-500/20">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-white">
                <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM12.75 6a.75.75 0 0 0-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 0 0 0-1.5h-3.75V6Z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-bold text-yellow-900 dark:text-yellow-200">
                Your Student Pass has expired
              </h3>
              <p className="text-sm text-yellow-800/80 dark:text-yellow-300/70 mt-1">
                Your 30-day pass ended on{' '}
                <span className="font-semibold">
                  {expiryDate?.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                </span>.
                Renew now to continue enjoying ₹0 service fees and priority printing!
              </p>
              <button
                onClick={onNavigateToPass}
                className="mt-3 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-yellow-400 to-yellow-600 text-black font-bold text-sm shadow-lg shadow-yellow-500/30 hover:shadow-yellow-500/40 hover:-translate-y-0.5 transition-all"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M4.755 10.059a7.5 7.5 0 0 1 12.548-3.364l1.903 1.903h-3.183a.75.75 0 1 0 0 1.5h4.992a.75.75 0 0 0 .75-.75V4.356a.75.75 0 0 0-1.5 0v3.18l-1.9-1.9A9 9 0 0 0 3.306 9.67a.75.75 0 1 0 1.45.388Zm15.408 3.352a.75.75 0 0 0-.919.53 7.5 7.5 0 0 1-12.548 3.364l-1.902-1.903h3.183a.75.75 0 0 0 0-1.5H2.984a.75.75 0 0 0-.75.75v4.992a.75.75 0 0 0 1.5 0v-3.18l1.9 1.9a9 9 0 0 0 15.059-4.035.75.75 0 0 0-.53-.918Z" clipRule="evenodd" />
                </svg>
                Renew Student Pass — ₹49
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Active Pass Status */}
      {passActive && daysRemaining > 0 && (
        <div className="rounded-2xl bg-gradient-to-r from-emerald-50 to-green-50 dark:from-emerald-900/20 dark:to-green-900/20 border border-emerald-200 dark:border-emerald-800/50 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-gradient-to-br from-yellow-400 to-yellow-600 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-black">
                <path fillRule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
                Student Pass Active — {daysRemaining} day{daysRemaining !== 1 ? 's' : ''} remaining
              </p>
              <p className="text-xs text-emerald-700/70 dark:text-emerald-300/60">
                Expires {expiryDate?.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
              </p>
            </div>
            <button
              onClick={onNavigateToPass}
              className="text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:underline"
            >
              Manage →
            </button>
          </div>
        </div>
      )}

      <Card title="Upload New Document" className="bg-brand-secondary/80 backdrop-blur-sm">
        <FileUploadForm userId={userId} isLoadingShops={isLoadingShops} onNavigateToPass={onNavigateToPass} />
      </Card>

      <Card title="My Print Orders" className="bg-brand-secondary/80 backdrop-blur-sm">
        {studentOrders.length > 0 ? (
          <StudentOrderList orders={studentOrders} />
        ) : (
          <p className="text-brand-lightText text-center py-4">You haven't placed any orders yet. Start by uploading a document!</p>
        )}
      </Card>

      <Card 
        title="Support Tickets" 
        className="bg-brand-secondary/80 backdrop-blur-sm"
        actions={
          <Button variant="primary" size="sm" onClick={() => setShowTicketForm(true)}>
            Raise Ticket
          </Button>
        }
      >
        {tickets.length > 0 ? (
          <TicketList tickets={tickets} />
        ) : (
          <p className="text-brand-lightText text-center py-4">No tickets raised yet.</p>
        )}
      </Card>

      {/* Settings Modal */}
      <Modal isOpen={isSettingsModalOpen} onClose={() => setIsSettingsModalOpen(false)} title="Student Settings" size="lg">
        <div className="space-y-6 pb-2">

          {/* Account Management */}
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-brand-lightText dark:text-gray-400 uppercase tracking-wider">Account</h4>
            <div className="bg-red-50 dark:bg-red-900/10 border border-red-200/50 dark:border-red-900/30 rounded-xl p-4 flex items-center justify-between">
               <div>
                  <p className="text-sm font-medium text-red-600 dark:text-red-400">Danger Zone</p>
                  <p className="text-xs text-red-500/80 dark:text-red-400/80 mt-1">Permanently remove your account</p>
               </div>
               <button
                 onClick={() => {
                   setIsSettingsModalOpen(false);
                   setShowDeleteConfirm(true);
                 }}
                 className="px-3 py-1.5 bg-white dark:bg-zinc-900 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400 font-semibold rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
               >
                 Delete Account
               </button>
            </div>
          </div>
        </div>
      </Modal>

      <TicketForm isOpen={showTicketForm} onClose={() => setShowTicketForm(false)} />

      {/* Delete Confirmation Modal */}
      <Modal isOpen={showDeleteConfirm} onClose={() => setShowDeleteConfirm(false)} title="Delete Account">
        <div className="space-y-4">
          <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800">
            <p className="text-sm text-red-700 dark:text-red-300 font-medium">
              ⚠️ This action cannot be undone.
            </p>
            <p className="text-sm text-red-600 dark:text-red-400 mt-2">
              Your account profile and all associated data will be permanently deleted. Any active orders may not be recoverable.
            </p>
          </div>
          <div className="flex gap-3">
            <Button
              variant="secondary"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isDeleting}
              fullWidth
            >
              Cancel
            </Button>
            <Button
              onClick={handleDeleteAccount}
              disabled={isDeleting}
              fullWidth
              className="!bg-red-600 hover:!bg-red-700 !text-white !border-red-600"
            >
              {isDeleting ? 'Deleting...' : 'Yes, Delete My Account'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default StudentDashboard;
