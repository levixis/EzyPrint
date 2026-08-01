import React, { useState, useEffect, useRef } from 'react';
import { SupportTicket, TicketStatus, UserType } from '../../types';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { useAppContext } from '../../contexts/AppContext';
import { uploadApi, adminApi } from '../../lib/queries';
import { RefundOtpModal } from '../common/RefundOtpModal';
import { RefundHistoryTracker } from '../common/RefundHistoryTracker';

interface TicketDetailProps {
  ticket: SupportTicket;
  isOpen: boolean;
  onClose: () => void;
}

const statusColors: Record<string, string> = {
  [TicketStatus.OPEN]: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
  [TicketStatus.IN_REVIEW]: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
  [TicketStatus.RESOLVED]: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400',
  [TicketStatus.CLOSED]: 'bg-gray-200 dark:bg-zinc-700 text-gray-600 dark:text-gray-400',
};

const statusIcons: Record<string, string> = {
  [TicketStatus.OPEN]: '🟢',
  [TicketStatus.IN_REVIEW]: '🔍',
  [TicketStatus.RESOLVED]: '✅',
  [TicketStatus.CLOSED]: '🔒',
};

const refundStatusTone: Record<string, string> = {
  PENDING_SHOP: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/30 text-amber-700 dark:text-amber-300',
  APPROVED_BY_SHOP: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/30 text-emerald-700 dark:text-emerald-300',
  REJECTED_BY_SHOP: 'bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800/30 text-rose-700 dark:text-rose-300',
  ESCALATED_TO_ADMIN: 'bg-violet-50 dark:bg-violet-900/20 border-violet-200 dark:border-violet-800/30 text-violet-700 dark:text-violet-300',
  AUTO_ESCALATED: 'bg-violet-50 dark:bg-violet-900/20 border-violet-200 dark:border-violet-800/30 text-violet-700 dark:text-violet-300',
  RESOLVED_REFUNDED: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/30 text-emerald-700 dark:text-emerald-300',
  RESOLVED_DENIED: 'bg-slate-100 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300',
};

const formatRefundRequestStatus = (status: string) => status.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// Helper: extract filename from a storage path like "tickets/ticket_123/myfile.pdf"
const getFileNameFromPath = (path: string): string => {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
};

// Helper: get a display-friendly icon for common file types
const getFileIcon = (fileName: string): string => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return '🖼️';
  if (ext === 'pdf') return '📄';
  if (['doc', 'docx'].includes(ext)) return '📝';
  if (ext === 'txt') return '📃';
  return '📎';
};

const TicketDetail: React.FC<TicketDetailProps> = ({ ticket, isOpen, onClose }) => {
  const { addNotification, addTicketMessage, updateTicketStatus, currentUser, tickets, orders, allOrders, shopInitiateRefund, escalateTicketToAdmin, refundRequests } = useAppContext();
  const [replyText, setReplyText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [isPreApproveModalOpen, setIsPreApproveModalOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Attachment download URLs
  const [attachmentUrls, setAttachmentUrls] = useState<{ path: string; url: string; fileName: string; error?: boolean }[]>([]);
  const [isLoadingAttachments, setIsLoadingAttachments] = useState(false);

  // Get live ticket data from the tickets array
  const liveTicket = tickets.find(t => t.id === ticket.id) || ticket;
  const isAdmin = currentUser?.type === UserType.ADMIN;
  const isClosed = liveTicket.status === TicketStatus.CLOSED || liveTicket.status === TicketStatus.RESOLVED;

  // Resolve related order: allOrders is only populated for ADMIN; students/shop owners use orders
  const combinedOrders = isAdmin ? allOrders : orders;
  const relatedOrder = liveTicket.relatedOrderId ? combinedOrders.find(o => o.id === liveTicket.relatedOrderId) : null;
  const refundRequest = liveTicket.relatedOrderId ? refundRequests.find(r => r.orderId === liveTicket.relatedOrderId) : null;
  const [isIssuingRefund, setIsIssuingRefund] = useState(false);
  const [refundResult, setRefundResult] = useState<{ success: boolean; message: string } | null>(null);

  const [isRequestingOTP, setIsRequestingOTP] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [isRefundModalOpen, setIsRefundModalOpen] = useState(false);
  const [isEscalateModalOpen, setIsEscalateModalOpen] = useState(false);
  const [escalationReason, setEscalationReason] = useState('');

  const handleRequestOTP = async () => {
    if (!relatedOrder) return;
    setIsRequestingOTP(true);
    setRefundResult(null);
    try {
      await adminApi.requestOTP(`refund_${relatedOrder.id}`);
      setOtpSent(true);
      setRefundResult({ success: true, message: 'OTP sent to your admin email!' });
    } catch (err) {
      const error = err as Error;
      setRefundResult({ success: false, message: error.message || 'Failed to send OTP.' });
    }
    setIsRequestingOTP(false);
  };

  const handleConfirmRefund = async (enteredOtp: string) => {
    if (!relatedOrder || !enteredOtp.trim()) return;
    setIsIssuingRefund(true);
    setRefundResult(null);
    try {
      const data = await adminApi.executeAction('initiateRefund', enteredOtp.trim()) as unknown as { success: boolean; message: string };
      setRefundResult({ success: true, message: data.message || 'Refund successfully initiated.' });
      setOtpSent(false);
    } catch (err) {
      const error = err as Error;
      setRefundResult({ success: false, message: error.message || 'Refund failed. Invalid OTP?' });
    }
    setIsIssuingRefund(false);
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [liveTicket.messages.length]);

  // Resolve attachment storage paths to download URLs
  useEffect(() => {
    const hasLegacy = liveTicket.attachmentPaths && liveTicket.attachmentPaths.length > 0;
    const hasNew = liveTicket.attachments && liveTicket.attachments.length > 0;
    
    if (!isOpen || (!hasLegacy && !hasNew)) {
      setAttachmentUrls([]);
      return;
    }

    let cancelled = false;
    setIsLoadingAttachments(true);

    const resolveUrls = async () => {
      const legacyPaths = liveTicket.attachmentPaths ?? [];
      const newPaths = (liveTicket.attachments ?? []).map(a => ({ path: a.storageKey, originalName: a.originalName }));
      
      const allPaths = [...legacyPaths.map(p => ({ path: p, originalName: getFileNameFromPath(p) })), ...newPaths];

      const results = await Promise.all(
        allPaths.map(async ({ path, originalName }) => {
          try {
            const result = await uploadApi.getDownloadUrl(path);
            return { path, url: result.url, fileName: originalName };
          } catch {
            return { path, url: '', fileName: originalName, error: true };
          }
        })
      );
      if (!cancelled) {
        setAttachmentUrls(results);
        setIsLoadingAttachments(false);
      }
    };

    resolveUrls();
    return () => { cancelled = true; };
  }, [isOpen, liveTicket.attachmentPaths, liveTicket.attachments]);

  const handleSendReply = async () => {
    if (!replyText.trim()) return;
    setIsSending(true);
    const result = await addTicketMessage(liveTicket.id, replyText.trim());
    if (result.success) {
      setReplyText('');
    }
    setIsSending(false);
  };

  const handleStatusChange = async (newStatus: TicketStatus) => {
    setIsUpdatingStatus(true);
    await updateTicketStatus(liveTicket.id, newStatus);
    setIsUpdatingStatus(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendReply();
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="" size="full" hideCloseButton>
      <div className="flex flex-col lg:h-[65vh]">
        {/* Header Bar */}
        <div className="flex items-center justify-between gap-3 pb-4 border-b border-gray-200 dark:border-zinc-700">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="min-w-0 flex-1">
              <h3 className="text-lg sm:text-xl font-bold text-gray-900 dark:text-white line-clamp-2 leading-snug">
                {liveTicket.subject}
              </h3>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${statusColors[liveTicket.status]}`}>
                  {statusIcons[liveTicket.status]} {liveTicket.status.replace(/_/g, ' ')}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {liveTicket.category.replace(/_/g, ' ')}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  • {new Date(liveTicket.createdAt).toLocaleDateString()}
                </span>
              </div>
            </div>
          </div>
          <button onClick={onClose} className="flex-shrink-0 p-2 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Two-Column Layout */}
        <div className="flex flex-col lg:flex-row gap-5 mt-4 flex-1 lg:min-h-0">
          {/* Left Column: Ticket Info + Attachments */}
          <div className="w-full lg:w-[340px] flex-shrink-0 space-y-4 lg:overflow-y-auto pr-1 lg:pb-4">
            {/* Raised By Info */}
            <div className="bg-gray-50 dark:bg-zinc-800/50 rounded-xl p-4 border border-gray-200 dark:border-zinc-700 space-y-2.5">
              <h5 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Ticket Info</h5>
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-gray-400 flex-shrink-0">
                    <path d="M10 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.465 14.493a1.23 1.23 0 0 0 .41 1.412A9.957 9.957 0 0 0 10 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 0 0-13.074.003Z" />
                  </svg>
                  <span className="text-gray-700 dark:text-gray-300">{liveTicket.raisedByName}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                    liveTicket.raisedByType === UserType.STUDENT
                      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                      : 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'
                  }`}>
                    {liveTicket.raisedByType === UserType.STUDENT ? 'Student' : 'Shop'}
                  </span>
                </div>
                {liveTicket.raisedByEmail && (
                  <div className="flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-gray-400 flex-shrink-0">
                      <path d="M3 4a2 2 0 0 0-2 2v1.161l8.441 4.221a1.25 1.25 0 0 0 1.118 0L19 7.161V6a2 2 0 0 0-2-2H3Z" />
                      <path d="m19 8.839-7.77 3.885a2.75 2.75 0 0 1-2.46 0L1 8.839V14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.839Z" />
                    </svg>
                    <span className="text-gray-600 dark:text-gray-400 truncate">{liveTicket.raisedByEmail}</span>
                  </div>
                )}
                {liveTicket.relatedOrderId && (
                  <div className="flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-gray-400 flex-shrink-0">
                      <path fillRule="evenodd" d="M4.5 2A1.5 1.5 0 0 0 3 3.5v13A1.5 1.5 0 0 0 4.5 18h11a1.5 1.5 0 0 0 1.5-1.5V7.621a1.5 1.5 0 0 0-.44-1.06l-4.12-4.122A1.5 1.5 0 0 0 11.378 2H4.5Z" clipRule="evenodd" />
                    </svg>
                    <span className="text-gray-600 dark:text-gray-400">Order #{liveTicket.relatedOrderId.slice(-6)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Description */}
            <div className="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-700">
              <h5 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Description</h5>
              <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
                {liveTicket.description}
              </p>
            </div>

            {/* Attachments Section */}
            {( (liveTicket.attachmentPaths?.length ?? 0) > 0 || (liveTicket.attachments?.length ?? 0) > 0 ) && (
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-700 overflow-hidden">
                <div className="px-4 py-2.5 border-b border-gray-200 dark:border-zinc-700 flex items-center gap-2">
                  <span className="text-sm">📎</span>
                  <h5 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Attachments ({(liveTicket.attachmentPaths?.length ?? 0) + (liveTicket.attachments?.length ?? 0)})
                  </h5>
                </div>
                <div className="p-3 space-y-2">
                  {isLoadingAttachments ? (
                    <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-2">Loading attachments…</p>
                  ) : (
                    attachmentUrls.map((att) => (
                      <div key={att.path} className="flex items-center gap-3 bg-gray-50 dark:bg-zinc-800 px-3 py-2.5 rounded-lg border border-gray-100 dark:border-zinc-700">
                        <span className="text-lg flex-shrink-0">{getFileIcon(att.fileName)}</span>
                        <span className="text-sm text-gray-700 dark:text-gray-300 truncate flex-1 min-w-0">
                          {att.fileName}
                        </span>
                        {att.error ? (
                          <span className="text-xs text-red-500 flex-shrink-0">Failed</span>
                        ) : (
                          <a
                            href={att.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-brand-primary bg-brand-primary/10 hover:bg-brand-primary/20 rounded-lg transition-colors flex-shrink-0"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                              <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
                              <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
                            </svg>
                            View
                          </a>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* Admin Status Controls */}
            {isAdmin && !isClosed && (
              <div className="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-700 space-y-3">
                <h5 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Admin Actions</h5>
                <div className="flex flex-wrap gap-2">
                  {liveTicket.status !== TicketStatus.IN_REVIEW && (
                    <Button size="sm" variant="secondary" onClick={() => handleStatusChange(TicketStatus.IN_REVIEW)} disabled={isUpdatingStatus}>
                      🔍 Mark In Review
                    </Button>
                  )}
                  <Button size="sm" variant="primary" onClick={() => handleStatusChange(TicketStatus.RESOLVED)} disabled={isUpdatingStatus}
                    className="!bg-gradient-to-r !from-emerald-500 !to-green-600">
                    ✅ Resolve
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleStatusChange(TicketStatus.CLOSED)} disabled={isUpdatingStatus}>
                    🔒 Close
                  </Button>
                </div>
              </div>
            )}

            {/* Payment & Refund Controls (Admin Only) */}
            {isAdmin && relatedOrder && (
              <div className="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-700 space-y-3">
                <h5 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Payment Details</h5>
                <div className="space-y-2">
                  <div>
                    <p className="text-[10px] text-gray-400">Razorpay Payment ID</p>
                    <p className="text-xs font-mono text-gray-900 dark:text-white break-all">
                      {relatedOrder.razorpayPaymentId || <span className="text-gray-400 italic">No payment captured</span>}
                    </p>
                  </div>
                  {relatedOrder.refundId ? (
                    <div className="pt-2 border-t border-gray-100 dark:border-zinc-800">
                       <RefundHistoryTracker orderId={relatedOrder.id} />
                    </div>
                  ) : relatedOrder.razorpayPaymentId && !isClosed ? (
                    <>
                      <Button 
                        size="sm" 
                        variant="primary" 
                        onClick={() => setIsRefundModalOpen(true)}
                        className="!bg-gradient-to-r !from-violet-500 !to-purple-600 w-full mt-2"
                      >
                        💸 Issue Refund
                      </Button>

                      {isRefundModalOpen && (
                        <RefundOtpModal
                          isOpen={isRefundModalOpen}
                          onClose={() => { setIsRefundModalOpen(false); setRefundResult(null); setOtpSent(false); }}
                          orderId={relatedOrder.id}
                          onConfirm={handleConfirmRefund}
                          onRequestOTP={handleRequestOTP}
                          isIssuingRefund={isIssuingRefund}
                          isRequestingOTP={isRequestingOTP}
                          otpSent={otpSent}
                          resultMessage={refundResult}
                        />
                      )}
                    </>
                  ) : null}
                  {refundResult && !isRefundModalOpen && (
                    <p className={`text-xs mt-1 p-2 rounded ${refundResult.success ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/30' : 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800/30'}`}>
                      {refundResult.message}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Shop Controls */}
            {!isAdmin && currentUser?.type === UserType.SHOP_OWNER && liveTicket.shopId === currentUser.shopId && !isClosed && (
              <div className="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-700 space-y-3">
                <h5 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Shop Actions</h5>
                <div className="flex flex-col gap-2">
                  {liveTicket.relatedOrderId && (
                    <>
                      {refundRequest ? (
                        <div className={`rounded-xl border p-3 ${refundStatusTone[refundRequest.status] || 'bg-gray-50 dark:bg-zinc-800 border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-gray-300'}`}>
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold">
                                {refundRequest.status === 'APPROVED_BY_SHOP' ? 'Refund already pre-approved' : 'Refund request already exists'}
                              </p>
                              <p className="text-xs mt-1 opacity-90">
                                {refundRequest.status === 'APPROVED_BY_SHOP'
                                  ? 'This refund is awaiting admin processing. You can close or resolve this ticket now.'
                                  : `Current refund status: ${formatRefundRequestStatus(refundRequest.status)}.`}
                              </p>
                            </div>
                            <span className="px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide bg-white/70 dark:bg-black/20 border border-white/40 dark:border-white/10 whitespace-nowrap">
                              {formatRefundRequestStatus(refundRequest.status)}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <>
                          <Button size="sm" variant="primary" onClick={() => setIsPreApproveModalOpen(true)} disabled={isUpdatingStatus} className="!bg-gradient-to-r !from-indigo-500 !to-purple-600">
                            💸 Pre-approve Refund
                          </Button>

                          <Modal
                            isOpen={isPreApproveModalOpen}
                            onClose={() => setIsPreApproveModalOpen(false)}
                            title="Confirm Refund Pre-approval"
                            size="sm"
                          >
                            <div className="space-y-4">
                              <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                                Are you sure you want to pre-approve a refund for this order? This will authorize the Admin to process the refund for the student.
                              </p>
                              <div className="flex gap-3 justify-end pt-2">
                                <Button
                                  variant="ghost"
                                  onClick={() => setIsPreApproveModalOpen(false)}
                                  disabled={isUpdatingStatus}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  variant="primary"
                                  className="!bg-gradient-to-r !from-indigo-500 !to-purple-600"
                                  disabled={isUpdatingStatus}
                                  onClick={async () => {
                                    setIsUpdatingStatus(true);
                                    const result = await shopInitiateRefund(liveTicket.id, liveTicket.relatedOrderId!, "Refund pre-approved by shop");
                                    if (result.success) {
                                      await handleStatusChange(TicketStatus.CLOSED);
                                      setIsPreApproveModalOpen(false);
                                    } else {
                                      addNotification({ 
                                        message: result.message || "Could not pre-approve refund. The order might already be refunded or the time window may have expired.", 
                                        type: 'error' 
                                      });
                                    }
                                    setIsUpdatingStatus(false);
                                  }}
                                >
                                  {isUpdatingStatus ? 'Processing...' : 'Yes, Confirm'}
                                </Button>
                              </div>
                            </div>
                          </Modal>
                        </>
                      )}
                    </>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => handleStatusChange(TicketStatus.CLOSED)} disabled={isUpdatingStatus}>
                    🔒 Close Issue
                  </Button>
                </div>
              </div>
            )}

            {/* Student Controls */}
            {!isAdmin && currentUser?.type === UserType.STUDENT && liveTicket.raisedBy === currentUser.id && isClosed && (
              <div className="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-red-200 dark:border-red-900/30 space-y-3">
                <h5 className="text-xs font-bold text-red-500 dark:text-red-400 uppercase tracking-wider">Not Satisfied?</h5>
                <Button size="sm" variant="danger" onClick={() => setIsEscalateModalOpen(true)} disabled={isUpdatingStatus} className="w-full">
                  🚨 Escalate to Admin
                </Button>
              </div>
            )}

            <Modal isOpen={isEscalateModalOpen} onClose={() => { setIsEscalateModalOpen(false); setEscalationReason(''); }} title="Escalate to Admin" size="md">
              <div className="space-y-4">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Tell the admin why this ticket still needs intervention.
                </p>
                <textarea
                  value={escalationReason}
                  onChange={(e) => setEscalationReason(e.target.value)}
                  rows={4}
                  className="w-full rounded-xl border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-primary"
                  placeholder="Describe what is still unresolved..."
                />
                <div className="flex justify-end gap-3">
                  <Button variant="ghost" onClick={() => { setIsEscalateModalOpen(false); setEscalationReason(''); }}>
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    disabled={isUpdatingStatus || !escalationReason.trim()}
                    onClick={async () => {
                      setIsUpdatingStatus(true);
                      await escalateTicketToAdmin(liveTicket.id, escalationReason.trim());
                      setIsUpdatingStatus(false);
                      setIsEscalateModalOpen(false);
                      setEscalationReason('');
                      onClose();
                    }}
                  >
                    {isUpdatingStatus ? 'Escalating...' : 'Escalate'}
                  </Button>
                </div>
              </div>
            </Modal>

            {/* Status History */}
            {liveTicket.statusHistory.length > 1 && (
              <div className="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-700">
                <h5 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Status History</h5>
                <div className="space-y-2 pl-3 border-l-2 border-gray-200 dark:border-zinc-700">
                  {liveTicket.statusHistory.map((change, i) => (
                    <div key={i} className="text-xs text-gray-500 dark:text-gray-400">
                      <span className="font-semibold text-gray-700 dark:text-gray-300">{change.changedByName}</span>
                      {' → '}
                      <span className="font-semibold">{change.to.replace(/_/g, ' ')}</span>
                      {change.note && <span className="italic"> — "{change.note}"</span>}
                      <p className="text-gray-400 dark:text-gray-500 text-[10px] mt-0.5">
                        {new Date(change.timestamp).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Messages Thread + Reply */}
          <div className="flex flex-col flex-1 min-h-0 min-w-0">
            {/* Messages Header */}
            <div className="flex items-center justify-between pb-3 border-b border-gray-200 dark:border-zinc-700">
              <div className="flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-gray-400">
                  <path fillRule="evenodd" d="M3.43 2.524A41.29 41.29 0 0 1 10 2c2.236 0 4.43.18 6.57.524 1.437.231 2.43 1.49 2.43 2.902v5.148c0 1.413-.993 2.67-2.43 2.902a41.102 41.102 0 0 1-3.55.414c-.28.02-.521.18-.643.413l-1.712 3.293a.75.75 0 0 1-1.33 0l-1.713-3.293a.783.783 0 0 0-.642-.413 41.108 41.108 0 0 1-3.55-.414C1.993 13.245 1 11.986 1 10.574V5.426c0-1.413.993-2.67 2.43-2.902Z" clipRule="evenodd" />
                </svg>
                <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                  Conversation
                </h5>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  ({liveTicket.messages.length} message{liveTicket.messages.length !== 1 ? 's' : ''})
                </span>
              </div>
            </div>

            {/* Messages Thread — takes remaining space */}
            <div className="flex-1 lg:overflow-y-auto py-4 space-y-3 min-h-[200px] lg:min-h-0 lg:max-h-full">
              {liveTicket.messages.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="w-14 h-14 rounded-full bg-gray-100 dark:bg-zinc-800 flex items-center justify-center mb-3">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7 text-gray-300 dark:text-gray-600">
                      <path fillRule="evenodd" d="M4.804 21.644A6.707 6.707 0 0 0 6 21.75a6.721 6.721 0 0 0 3.583-1.029c.774.182 1.584.279 2.417.279 5.322 0 9.75-3.97 9.75-9 0-5.03-4.428-9-9.75-9s-9.75 3.97-9.75 9c0 2.409 1.025 4.587 2.674 6.192.232.226.277.428.254.543a3.73 3.73 0 0 1-.814 1.686.75.75 0 0 0 .44 1.223ZM8.25 10.875a1.125 1.125 0 1 0 0 2.25 1.125 1.125 0 0 0 0-2.25ZM10.875 12a1.125 1.125 0 1 1 2.25 0 1.125 1.125 0 0 1-2.25 0Zm4.875-1.125a1.125 1.125 0 1 0 0 2.25 1.125 1.125 0 0 0 0-2.25Z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <p className="text-sm text-gray-400 dark:text-gray-500">No messages yet</p>
                  <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">Start the conversation below</p>
                </div>
              )}
              {liveTicket.messages.map(msg => {
                const isCurrentUser = msg.senderId === currentUser?.id;
                const isAdminMsg = msg.senderType === UserType.ADMIN;
                return (
                  <div key={msg.id} className={`flex ${isCurrentUser ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] px-4 py-3 rounded-2xl ${
                      isCurrentUser
                        ? 'bg-brand-primary text-white rounded-br-md'
                        : isAdminMsg
                          ? 'bg-gradient-to-r from-indigo-50 to-purple-50 dark:from-indigo-900/30 dark:to-purple-900/30 text-gray-900 dark:text-white border border-indigo-200 dark:border-indigo-800/50 rounded-bl-md'
                          : 'bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-white rounded-bl-md'
                    }`}>
                      <p className={`text-xs font-semibold mb-1 ${isCurrentUser ? 'text-white/80' : isAdminMsg ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-500 dark:text-gray-400'}`}>
                        {msg.senderName} {isAdminMsg && '(Admin)'}
                      </p>
                      <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.message}</p>
                      <p className={`text-[10px] mt-1.5 ${isCurrentUser ? 'text-white/60' : 'text-gray-400 dark:text-gray-500'}`}>
                        {new Date(msg.timestamp).toLocaleString()}
                      </p>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Reply Box — Pinned at bottom */}
            {!isClosed ? (
              <div className="pt-3 border-t border-gray-200 dark:border-zinc-700">
                <div className="flex gap-2">
                  <textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value.slice(0, 2000))}
                    onKeyDown={handleKeyDown}
                    placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
                    rows={2}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:border-transparent transition-all resize-none text-sm"
                  />
                  <Button
                    variant="primary"
                    onClick={handleSendReply}
                    disabled={!replyText.trim() || isSending}
                    className="self-end shrink-0 w-11 h-11 !p-0 flex items-center justify-center rounded-xl"
                  >
                    {isSending ? (
                      <svg className="animate-spin w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                        <path d="M3.105 2.288a.75.75 0 0 0-.826.95l1.414 4.926A1.5 1.5 0 0 0 5.135 9.25h6.115a.75.75 0 0 1 0 1.5H5.135a1.5 1.5 0 0 0-1.442 1.086l-1.414 4.926a.75.75 0 0 0 .826.95 28.897 28.897 0 0 0 15.293-7.155.75.75 0 0 0 0-1.114A28.897 28.897 0 0 0 3.105 2.288Z" />
                      </svg>
                    )}
                  </Button>
                </div>
                <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1.5 ml-1">
                  {replyText.length}/2000 characters
                </p>
              </div>
            ) : (
              <div className="pt-3 border-t border-gray-200 dark:border-zinc-700">
                <p className="text-center text-sm text-gray-500 dark:text-gray-400 py-3 bg-gray-50 dark:bg-zinc-800 rounded-xl">
                  🔒 This ticket is {liveTicket.status.toLowerCase().replace(/_/g, ' ')}. No further replies can be added.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default TicketDetail;
