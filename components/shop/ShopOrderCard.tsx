import React from 'react';
import { DocumentOrder, OrderStatus, PrintColor } from '../../types';
import { Card } from '../common/Card';
import { Button } from '../common/Button';

interface ShopOrderCardProps {
  order: DocumentOrder;
  onSelectOrder: (orderId: string) => void;
}

const getStatusShopStyles = (status: OrderStatus): { text: string; border: string; bg: string; icon?: React.ReactNode } => {
  switch (status) {
    case OrderStatus.PENDING_PAYMENT: return { text: 'text-status-pending', border: 'border-status-pending', bg: 'bg-status-pending/20', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg> };
    case OrderStatus.PAYMENT_FAILED: return { text: 'text-status-error', border: 'border-status-error', bg: 'bg-status-error/20', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>};
    case OrderStatus.PENDING_APPROVAL: return { text: 'text-status-pending', border: 'border-status-pending', bg: 'bg-status-pending/20', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 11.664 0l3.181-3.183m-4.991-2.691V5.25A2.25 2.25 0 0 0 16.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v4.992" /></svg> };
    case OrderStatus.PRINTING: return { text: 'text-status-info', border: 'border-status-info', bg: 'bg-status-info/20', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a8.25 8.25 0 0 1 8.25-8.25H18M6.72 13.829L6.72 16.5m0 0v3m0-3H6.375m0-3A8.25 8.25 0 0 0 18 16.5M16.5 12V8.25" /></svg> };
    case OrderStatus.READY_FOR_PICKUP: return { text: 'text-status-success', border: 'border-status-success', bg: 'bg-status-success/20', icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 mr-1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg> };
    case OrderStatus.COMPLETED: return { text: 'text-brand-lightText', border: 'border-brand-muted', bg: 'bg-brand-secondaryLight/50' };
    case OrderStatus.CANCELLED: return { text: 'text-status-error', border: 'border-status-error', bg: 'bg-status-error/30' };
    default: return { text: 'text-brand-lightText', border: 'border-brand-muted', bg: 'bg-brand-secondary' };
  }
};

const FileIconShop: React.FC<{fileType: string}> = ({ fileType }) => {
    let iconPath = "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z";
    const typeUpper = fileType.toUpperCase();
    if (typeUpper === 'PDF') {
        iconPath = "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m.75 12V9.75M8.25 9.75h3M8.25 12h3m-3 2.25h3M3.375 2.25c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9h-3.375Z";
    }
    return (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-10 h-10 mr-4 text-brand-primary opacity-90 flex-shrink-0">
            <path strokeLinecap="round" strokeLinejoin="round" d={iconPath} />
        </svg>
    );
};

const ShopOrderCard: React.FC<ShopOrderCardProps> = ({ order, onSelectOrder }) => {
  const { id, fileName, fileType, userId, status, uploadedAt, printOptions, priceDetails } = order;
  const formattedStatus = status.replace(/_/g, ' ');
  const statusStyle = getStatusShopStyles(status);

  return (
    <Card className={`flex flex-col justify-between h-full hover:shadow-2xl hover:ring-2 hover:ring-brand-primary transition-all duration-200 border-l-4 ${statusStyle.border}`} noPadding>
      <div className="p-5">
        <div className="flex items-start mb-3">
            <FileIconShop fileType={fileType} />
            <div>
                 <h4 className="text-md font-semibold text-brand-text break-all leading-tight mb-0.5">{fileName}</h4>
                 <p className="text-xs text-brand-lightText">Order #{id.slice(-6)} (User: {userId.slice(-6)})</p>
            </div>
        </div>
        <div className={`text-xs font-semibold px-2.5 py-1 rounded-full border inline-flex items-center mb-3 capitalize ${statusStyle.border} ${statusStyle.text} ${statusStyle.bg}`}>
          {statusStyle.icon}
          {formattedStatus}
        </div>
        <div className="text-xs text-brand-lightText space-y-1">
          <p><strong>Received:</strong> {new Date(uploadedAt).toLocaleString()}</p>
          <p><strong>Options:</strong> {printOptions.copies}x, {printOptions.pages}pgs, {printOptions.color === PrintColor.COLOR ? 'Color' : 'B&W'}, {printOptions.doubleSided ? '2-sided' : '1-sided'}</p>
          <p><strong>Order Value:</strong> <span className="font-semibold text-brand-text">₹{priceDetails.totalPrice.toFixed(2)}</span></p>
          <p className="text-brand-muted italic">(Page Cost: ₹{priceDetails.pageCost.toFixed(2)}, Base Fee: ₹{priceDetails.baseFee.toFixed(2)})</p>
        </div>
      </div>
      <div className="p-4 border-t border-brand-muted/30 bg-brand-secondaryLight/30">
        <Button 
          onClick={() => onSelectOrder(id)} 
          variant="secondary" 
          size="sm"
          fullWidth
        >
          View Details & Update Status
        </Button>
      </div>
    </Card>
  );
};

export default ShopOrderCard;
