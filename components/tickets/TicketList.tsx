import React, { useState } from 'react';
import { SupportTicket, TicketStatus, TicketCategory, UserType } from '../../types';
import { Card } from '../common/Card';
import TicketDetail from './TicketDetail';

interface TicketListProps {
  tickets: SupportTicket[];
  title?: string;
  showRaiserInfo?: boolean; // true for admin view
}

const statusColors: Record<string, string> = {
  [TicketStatus.OPEN]: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
  [TicketStatus.IN_REVIEW]: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
  [TicketStatus.RESOLVED]: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400',
  [TicketStatus.CLOSED]: 'bg-gray-200 dark:bg-zinc-700 text-gray-600 dark:text-gray-400',
};

const categoryLabels: Record<string, string> = {
  [TicketCategory.ORDER_ISSUE]: '📦 Order',
  [TicketCategory.PAYMENT_ISSUE]: '💳 Payment',
  [TicketCategory.DELIVERY_ISSUE]: '🚚 Delivery',
  [TicketCategory.OTHER]: '🔹 Other',
};

const TicketList: React.FC<TicketListProps> = ({ tickets, title, showRaiserInfo }) => {
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null);

  if (tickets.length === 0) {
    return (
      <Card className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-center py-8">
        <p className="text-gray-500 dark:text-gray-400">
          {title || 'No tickets found.'}
        </p>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {tickets.map(ticket => (
          <button
            key={ticket.id}
            onClick={() => setSelectedTicket(ticket)}
            className="w-full text-left bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-700 p-4 hover:border-brand-primary/50 hover:shadow-md transition-all duration-200 group"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <h4 className="font-semibold text-gray-900 dark:text-white truncate group-hover:text-brand-primary transition-colors">
                    {ticket.subject}
                  </h4>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${statusColors[ticket.status]}`}>
                    {ticket.status.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                  <span>{categoryLabels[ticket.category]}</span>
                  {ticket.relatedOrderId && <span>• Order #{ticket.relatedOrderId.slice(-6)}</span>}
                  <span>• {new Date(ticket.createdAt).toLocaleDateString()}</span>
                  {showRaiserInfo && (
                    <>
                      <span>• {ticket.raisedByName}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${ticket.raisedByType === UserType.STUDENT ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' : 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'}`}>
                        {ticket.raisedByType === UserType.STUDENT ? 'Student' : 'Shop'}
                      </span>
                    </>
                  )}
                </div>
                {ticket.messages.length > 0 && (
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 truncate">
                    Last: {ticket.messages[ticket.messages.length - 1].senderName} — "{ticket.messages[ticket.messages.length - 1].message.slice(0, 80)}..."
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                <span className="text-xs text-gray-400 dark:text-gray-500">{ticket.messages.length} msgs</span>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-gray-400 group-hover:text-brand-primary transition-colors">
                  <path fillRule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.638L10.23 5.29a.75.75 0 1 1 1.04-1.08l5.5 5.25a.75.75 0 0 1 0 1.08l-5.5 5.25a.75.75 0 1 1-1.04-1.08l4.158-3.96H3.75A.75.75 0 0 1 3 10Z" clipRule="evenodd" />
                </svg>
              </div>
            </div>
          </button>
        ))}
      </div>

      {selectedTicket && (
        <TicketDetail
          ticket={selectedTicket}
          isOpen={!!selectedTicket}
          onClose={() => setSelectedTicket(null)}
        />
      )}
    </>
  );
};

export default TicketList;
