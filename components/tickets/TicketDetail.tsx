import React, { useState, useEffect, useRef } from 'react';
import { SupportTicket, TicketStatus, UserType } from '../../types';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { useAppContext } from '../../contexts/AppContext';
import { storage, storageRef, getDownloadURL } from '../../firebase';

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
  const { addTicketMessage, updateTicketStatus, currentUser, tickets } = useAppContext();
  const [replyText, setReplyText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Attachment download URLs
  const [attachmentUrls, setAttachmentUrls] = useState<{ path: string; url: string; fileName: string; error?: boolean }[]>([]);
  const [isLoadingAttachments, setIsLoadingAttachments] = useState(false);

  // Get live ticket data from the tickets array
  const liveTicket = tickets.find(t => t.id === ticket.id) || ticket;
  const isAdmin = currentUser?.type === UserType.ADMIN;
  const isClosed = liveTicket.status === TicketStatus.CLOSED || liveTicket.status === TicketStatus.RESOLVED;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [liveTicket.messages.length]);

  // Resolve attachment storage paths to download URLs
  useEffect(() => {
    if (!isOpen || !liveTicket.attachmentPaths || liveTicket.attachmentPaths.length === 0) {
      setAttachmentUrls([]);
      return;
    }

    let cancelled = false;
    setIsLoadingAttachments(true);

    const resolveUrls = async () => {
      const results = await Promise.all(
        liveTicket.attachmentPaths.map(async (path) => {
          const fileName = getFileNameFromPath(path);
          try {
            const ref = storageRef(storage, path);
            const url = await getDownloadURL(ref);
            return { path, url, fileName };
          } catch {
            return { path, url: '', fileName, error: true };
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
  }, [isOpen, liveTicket.attachmentPaths]);

  const handleSendReply = async () => {
    if (!replyText.trim()) return;
    setIsSending(true);
    await addTicketMessage(liveTicket.id, replyText.trim());
    setReplyText('');
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
            <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-md shadow-purple-500/20">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white">
                <path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0 1 12 2.25c2.43 0 4.817.178 7.152.52a1.834 1.834 0 0 1 1.529 1.657l.293 3.513a1.834 1.834 0 0 1-1.307 1.92l-.416.14a3.118 3.118 0 0 0-1.898 4.084l.108.27a1.835 1.835 0 0 1-.9 2.267l-3.19 1.595a1.835 1.835 0 0 1-2.118-.355L9.69 16.3a3.118 3.118 0 0 0-4.253-.143l-.295.268a1.834 1.834 0 0 1-2.445-.198l-1.06-1.162a1.834 1.834 0 0 1-.286-2.066l.168-.336a3.118 3.118 0 0 0-1.034-3.82l-.35-.247A1.834 1.834 0 0 1 .26 6.62l.592-3.209a1.835 1.835 0 0 1 1.532-1.494l2.464-.146Z" clipRule="evenodd" />
              </svg>
            </div>
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
            {liveTicket.attachmentPaths.length > 0 && (
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-700 overflow-hidden">
                <div className="px-4 py-2.5 border-b border-gray-200 dark:border-zinc-700 flex items-center gap-2">
                  <span className="text-sm">📎</span>
                  <h5 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Attachments ({liveTicket.attachmentPaths.length})
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
                      <path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0 1 12 2.25c2.43 0 4.817.178 7.152.52a1.834 1.834 0 0 1 1.529 1.657l.293 3.513a1.834 1.834 0 0 1-1.307 1.92l-.416.14a3.118 3.118 0 0 0-1.898 4.084l.108.27a1.835 1.835 0 0 1-.9 2.267l-3.19 1.595a1.835 1.835 0 0 1-2.118-.355L9.69 16.3a3.118 3.118 0 0 0-4.253-.143l-.295.268a1.834 1.834 0 0 1-2.445-.198l-1.06-1.162a1.834 1.834 0 0 1-.286-2.066l.168-.336a3.118 3.118 0 0 0-1.034-3.82l-.35-.247A1.834 1.834 0 0 1 .26 6.62l.592-3.209a1.835 1.835 0 0 1 1.532-1.494l2.464-.146Z" clipRule="evenodd" />
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
                    className="self-end"
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
