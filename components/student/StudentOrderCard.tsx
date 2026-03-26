import React from 'react';
import { DocumentOrder, OrderStatus, PrintColor } from '../../types';
import { Card } from '../common/Card';
import { Button } from '../common/Button';
import { useAppContext } from '../../contexts/AppContext';
import { getOrderFiles, getOrderDisplayName } from '../../utils/orderHelpers';

interface StudentOrderCardProps {
  order: DocumentOrder;
  onPayNow: (order: DocumentOrder) => void;
  onCancelOrder?: (order: DocumentOrder) => void;
}

const getStatusStyles = (status: OrderStatus): { text: string; border: string; bg: string; icon?: React.ReactNode } => {
  switch (status) {
    case OrderStatus.PENDING_PAYMENT: return { text: 'text-status-pending', border: 'border-status-pending', bg: 'bg-status-pending/20', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg> };
    case OrderStatus.PAYMENT_FAILED: return { text: 'text-status-error', border: 'border-status-error', bg: 'bg-status-error/20', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg> };
    case OrderStatus.PENDING_APPROVAL: return { text: 'text-status-pending', border: 'border-status-pending', bg: 'bg-status-pending/20', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 11.664 0l3.181-3.183m-4.991-2.691V5.25A2.25 2.25 0 0 0 16.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v4.992" /></svg> };
    case OrderStatus.PRINTING: return { text: 'text-status-info', border: 'border-status-info', bg: 'bg-status-info/20', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a8.25 8.25 0 0 1 8.25-8.25H18M6.72 13.829L6.72 16.5m0 0v3m0-3H6.375m0-3A8.25 8.25 0 0 0 18 16.5M16.5 12V8.25" /></svg> };
    case OrderStatus.READY_FOR_PICKUP: return { text: 'text-status-success', border: 'border-status-success', bg: 'bg-status-success/20', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg> };
    case OrderStatus.COMPLETED: return { text: 'text-green-500', border: 'border-green-500', bg: 'bg-green-500/10', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg> };
    case OrderStatus.CANCELLED: return { text: 'text-status-error', border: 'border-status-error', bg: 'bg-status-error/30', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg> };
    default: return { text: 'text-brand-lightText', border: 'border-brand-muted', bg: 'bg-brand-secondary' };
  }
};

const FileIcon: React.FC<{ fileType: string }> = ({ fileType }) => {
  let iconPath = "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z";
  const typeUpper = fileType.toUpperCase();
  if (typeUpper === 'PDF') {
    iconPath = "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12V9.75M8.25 9.75h3M8.25 12h3m-3 2.25h3M3.375 2.25c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9h-3.375Z";
  } else if (['DOCX', 'TXT'].includes(typeUpper)) {
    iconPath = "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h9M8.25 12h9m-9 2.25h9M3.375 2.25c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9h-3.375Z";
  } else if (['JPEG', 'PNG', 'JPG'].includes(typeUpper)) {
    iconPath = "M2.25 15.75l5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.158 0a.225.225 0 1 1-.45 0 .225.225 0 0 1 .45 0Z";
  }
  return (
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-brand-primary flex-shrink-0">
      <path strokeLinecap="round" strokeLinejoin="round" d={iconPath} />
    </svg>
  );
};


const StudentOrderCard: React.FC<StudentOrderCardProps> = ({ order, onPayNow, onCancelOrder }) => {
  const { getShopById } = useAppContext();
  const { printOptions, status, priceDetails, uploadedAt, id, pickupCode, shopNotes, shopId } = order;
  const [showInvoice, setShowInvoice] = React.useState(false);
  const [showFiles, setShowFiles] = React.useState(false);

  const files = getOrderFiles(order);
  const displayName = getOrderDisplayName(order);
  const shop = getShopById(shopId);
  const formattedStatus = status.replace(/_/g, ' ');
  const statusStyle = getStatusStyles(status);

  return (
    <Card className={`border-l-4 ${statusStyle.border} transition-all hover:shadow-2xl bg-opacity-80 backdrop-blur-sm ${status === OrderStatus.PENDING_PAYMENT || status === OrderStatus.PAYMENT_FAILED ? 'ring-2 ring-brand-primaryDark' : ''}`}>
      <div className="flex flex-col sm:flex-row justify-between sm:items-start mb-4 pb-4 border-b border-brand-muted/30">
        <div className="flex items-start gap-2">
          <div className="mt-1">
            <FileIcon fileType={files[0]?.fileType || order.fileType} />
          </div>
          <div>
            <h4 className="text-lg font-semibold text-brand-text dark:text-gray-100 break-all leading-tight">{displayName}</h4>
            <p className="text-xs text-brand-lightText dark:text-gray-400">
              Order ID: #{id.slice(-8)} @ {shop?.name || 'Shop'}
              {files.length > 1 && (
                <button onClick={() => setShowFiles(!showFiles)} className="ml-2 text-brand-primary hover:underline">
                  {showFiles ? 'Hide files' : `View all ${files.length} files`}
                </button>
              )}
            </p>
          </div>
        </div>
        <span className={`mt-2 sm:mt-0 text-xs font-semibold px-3 py-1.5 rounded-full border ${statusStyle.border} ${statusStyle.text} ${statusStyle.bg} capitalize inline-flex items-center`}>
          {statusStyle.icon}
          {formattedStatus}
        </span>
      </div>

      {/* Expandable file list */}
      {showFiles && files.length > 1 && (
        <div className="mb-4 p-3 bg-brand-secondaryLight/50 dark:bg-zinc-800/50 rounded-xl space-y-2">
          {files.map((file, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <FileIcon fileType={file.fileType} />
              <span className="text-brand-text dark:text-white truncate flex-1">{file.fileName}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                file.color === PrintColor.COLOR
                  ? 'bg-gradient-to-r from-blue-100 to-purple-100 dark:from-blue-900/30 dark:to-purple-900/30 text-purple-700 dark:text-purple-300'
                  : 'bg-gray-100 dark:bg-zinc-700 text-gray-600 dark:text-gray-300'
              }`}>
                {file.color === PrintColor.COLOR ? 'Color' : 'B&W'}
              </span>
              <span className="text-xs text-brand-lightText">{file.pageCount}pg × {file.copies}cp{file.doubleSided ? ' • 2-sided' : ''}</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm text-brand-lightText dark:text-gray-300 mb-4">
        <p><strong>Date:</strong> {new Date(uploadedAt).toLocaleDateString()}</p>
        <p><strong>Files:</strong> {files.length}</p>
        <p><strong>Total Pages:</strong> {printOptions.pages}</p>
        <p><strong>Shop:</strong> {shop?.name || 'N/A'}</p>
      </div>
      <div className="p-3 bg-brand-primary/5 dark:bg-brand-primary/10 rounded-lg mb-4 border border-brand-primary/10">
        <div className="flex justify-between items-center text-base font-semibold text-brand-text dark:text-gray-200">
          <span className="flex items-center gap-2">
            Total Price
            <button onClick={() => setShowInvoice(!showInvoice)} className="text-xs font-normal text-brand-primary hover:underline focus:outline-none">
              ({showInvoice ? 'Hide Invoice' : 'View Invoice'})
            </button>
          </span>
          <span className="text-brand-primary text-lg">₹{priceDetails.totalPrice.toFixed(2)}</span>
        </div>
        {showInvoice && (
          <div className="mt-3 pt-2 border-t border-brand-primary/10 text-xs text-brand-lightText dark:text-gray-400 space-y-1 animation-fade-in">
            <div className="flex justify-between"><span>Page Cost:</span> <span>₹{priceDetails.pageCost.toFixed(2)}</span></div>
            <div className="flex justify-between"><span>Base Fee:</span> <span>₹{priceDetails.baseFee.toFixed(2)}</span></div>
          </div>
        )}
      </div>


      {(status === OrderStatus.PENDING_PAYMENT || status === OrderStatus.PAYMENT_FAILED) && (
        <div className={`my-2 p-3 ${status === OrderStatus.PAYMENT_FAILED ? 'bg-status-error/20 border-status-error' : 'bg-transparent'} rounded-lg border text-center flex flex-col gap-2`}>
          {status === OrderStatus.PAYMENT_FAILED && <p className="text-status-error font-semibold mb-2">Payment Failed. Please try again.</p>}
          <Button onClick={() => onPayNow(order)} variant="primary" size="md" fullWidth className="my-1">
            {status === OrderStatus.PENDING_PAYMENT ? `Pay Now ₹${priceDetails.totalPrice.toFixed(2)}` : `Retry Payment ₹${priceDetails.totalPrice.toFixed(2)}`}
          </Button>
          {onCancelOrder && (
            <Button onClick={() => onCancelOrder(order)} variant="ghost" size="sm" fullWidth className="text-status-error hover:bg-status-error/10 border border-transparent hover:border-status-error/20 mt-1">
              Cancel & Hide Order
            </Button>
          )}
        </div>
      )}

      {status === OrderStatus.READY_FOR_PICKUP && pickupCode && (
        <div className="mt-4 p-3 bg-status-success/20 rounded-lg border border-status-success">
          <p className="text-status-success font-semibold">Your order is ready for pickup at {shop?.name}!</p>
          <p className="text-brand-text">Pickup Code: <strong className="text-xl text-white tracking-wider bg-brand-primary px-2 py-0.5 rounded">{pickupCode}</strong></p>
        </div>
      )}
      {shopNotes && (
        <div className="mt-4 p-3 bg-brand-secondaryLight/50 rounded-lg border border-brand-muted/30">
          <p className="text-xs text-brand-muted font-semibold mb-1">Shop Notes:</p>
          <p className="text-sm text-brand-lightText whitespace-pre-wrap">{shopNotes}</p>
        </div>
      )}
    </Card>
  );
};

export default StudentOrderCard;
