
import React, { useState, useMemo } from 'react';
import { useAppContext } from '../../contexts/AppContext';
import { DocumentOrder, OrderStatus, ShopPricing, PayoutMethod } from '../../types'; // Removed ShopProfile import
import ShopOrderList from './ShopOrderList';
import ShopOrderDetailsModal from './ShopOrderDetailsModal';
import ShopSettingsModal from './ShopSettingsModal';
import { Card } from '../common/Card';
import { Button } from '../common/Button';

interface ShopDashboardProps {
  shopId: string;
  // ownerId: string; // Removed ownerId as it was not used in the component
}

const ShopDashboard: React.FC<ShopDashboardProps> = ({ shopId }) => {
  const { getOrdersForCurrentUser, updateOrderStatus, getShopById, updateShopSettings } = useAppContext(); // Removed currentUser
  const [selectedOrder, setSelectedOrder] = useState<DocumentOrder | null>(null);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);

  const shopProfile = useMemo(() => getShopById(shopId), [shopId, getShopById]);

  const allShopOrders = getOrdersForCurrentUser();

  const handleSelectOrder = (orderId: string) => {
    const order = allShopOrders.find(o => o.id === orderId);
    if (order) setSelectedOrder(order);
  };

  const handleCloseModal = () => setSelectedOrder(null);
  const handleOpenSettingsModal = () => setIsSettingsModalOpen(true);
  const handleCloseSettingsModal = () => setIsSettingsModalOpen(false);

  const handleSaveShopSettings = (sId: string, newSettings: { pricing: ShopPricing; isOpen: boolean; payoutMethods?: PayoutMethod[] }) => {
    updateShopSettings(sId, newSettings);
  };

  const shopRelevantOrders = allShopOrders.filter(o => o.status !== OrderStatus.PENDING_PAYMENT && o.status !== OrderStatus.PAYMENT_FAILED);

  if (!shopProfile) {
    return <p className="text-status-error text-center p-5">Shop profile not found. Please contact support.</p>;
  }

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center mb-6">
        <div>
            <h2 className="text-3xl font-bold text-brand-text">Shop Dashboard: {shopProfile.name}</h2>
            <p className="text-brand-lightText text-sm">{shopProfile.address} - {shopProfile.isOpen ? <span className="text-status-success font-semibold">Open for Orders</span> : <span className="text-status-error font-semibold">Currently Closed</span>}</p>
        </div>
        <Button onClick={handleOpenSettingsModal} variant="secondary" size="md"
            leftIcon={<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 0 1 1.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.108 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.11v1.093c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.27.96-.12 1.45l-.773.773a1.125 1.125 0 0 1-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.78.93l-.15.894c-.09.542-.56.94-1.11-.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.149-.894c-.07-.424-.384-.764-.78-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-.96.27-1.45-.12l-.773-.774a1.125 1.125 0 0 1-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.506-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.11v-1.094c0-.55.398-1.019.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.107-1.204l-.527-.738a1.125 1.125 0 0 1 .12-1.45l.773-.773a1.125 1.125 0 0 1 1.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505-.78-.93l.15-.894Z" /></svg>}
        >
            Shop Settings
        </Button>
      </div>

      <Card title="Incoming & Active Orders" className="bg-brand-secondary/80 backdrop-blur-sm">
        {shopRelevantOrders.length > 0 ? (
          <ShopOrderList orders={shopRelevantOrders} onSelectOrder={handleSelectOrder} />
        ) : (
          <p className="text-brand-lightText text-center py-4">No orders requiring shop attention at the moment. Good job!</p>
        )}
      </Card>

      {selectedOrder && (
        <ShopOrderDetailsModal
          order={selectedOrder}
          isOpen={!!selectedOrder}
          onClose={handleCloseModal}
          updateOrderStatus={updateOrderStatus}
        />
      )}
      {shopProfile && (
        <ShopSettingsModal
            isOpen={isSettingsModalOpen}
            onClose={handleCloseSettingsModal}
            shop={shopProfile}
            onSaveSettings={handleSaveShopSettings}
        />
      )}
    </div>
  );
};

export default ShopDashboard;
