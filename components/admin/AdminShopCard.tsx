import React, { useState } from 'react';
import { ShopProfile, DocumentOrder, OrderStatus, ShopPayout, PayoutStatus } from '../../types';
import { Card } from '../common/Card';
import { Button } from '../common/Button';
import { useAppContext } from '../../contexts/AppContext';

interface AdminShopCardProps {
  shop: ShopProfile;
  orders: DocumentOrder[];
  payouts: ShopPayout[];
  onCreatePayout: (shop: ShopProfile) => void;
}

const AdminShopCard: React.FC<AdminShopCardProps> = ({ shop, orders, payouts, onCreatePayout }) => {
  const { approveShop, rejectShop, deleteShopAndOwner, archiveShop, unarchiveShop } = useAppContext();
  const [isProcessing, setIsProcessing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const shopOrders = orders.filter(o => o.shopId === shop.id);
  // Only count fully completed orders as earned revenue
  const paidOrders = shopOrders.filter(o => o.status === OrderStatus.COMPLETED);
  const activeOrders = shopOrders.filter(o => 
    o.status !== OrderStatus.COMPLETED && 
    o.status !== OrderStatus.CANCELLED && 
    o.status !== OrderStatus.PAYMENT_FAILED
  );

  // Revenue = sum of pageCost from paid orders (baseFee goes to platform)
  const totalRevenue = paidOrders.reduce((sum, o) => sum + o.priceDetails.pageCost, 0);
  // Total paid out via confirmed/paid payouts
  const totalPaidOut = payouts
    .filter(p => p.shopId === shop.id && (p.status === PayoutStatus.CONFIRMED || p.status === PayoutStatus.PAID))
    .reduce((sum, p) => sum + p.amount, 0);
  const pendingAmount = Math.max(0, totalRevenue - totalPaidOut);

  const primaryUpi = shop.payoutMethods?.find(pm => pm.isPrimary && pm.type === 'UPI');
  const anyUpi = shop.payoutMethods?.find(pm => pm.type === 'UPI');
  const upiMethod = primaryUpi || anyUpi;

  const handleApprove = async () => {
    setIsProcessing(true);
    await approveShop(shop.id);
    setIsProcessing(false);
  };

  const handleReject = async () => {
    setIsProcessing(true);
    await rejectShop(shop.id);
    setIsProcessing(false);
  };

  const handleDelete = async () => {
    setIsProcessing(true);
    await deleteShopAndOwner(shop.id, shop.ownerUserId);
    setIsProcessing(false);
    setShowDeleteConfirm(false);
  };

  const handleArchiveToggle = async () => {
    setIsProcessing(true);
    if (shop.isArchived) {
      await unarchiveShop(shop.id);
    } else {
      await archiveShop(shop.id);
    }
    setIsProcessing(false);
  };

  return (
    <Card className={`bg-white dark:bg-zinc-900 shadow-lg border hover:shadow-xl transition-all duration-300 ${!shop.isApproved ? 'border-amber-300 dark:border-amber-700' : shop.isArchived ? 'border-gray-300 dark:border-zinc-600 opacity-75' : 'border-gray-200 dark:border-zinc-700 hover:border-brand-primary/30'}`} noPadding>
      <div className="p-5">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center shadow-md ${!shop.isApproved ? 'bg-gradient-to-br from-amber-400 to-orange-500' : shop.isArchived ? 'bg-gradient-to-br from-gray-400 to-gray-500' : 'bg-gradient-to-br from-indigo-500 to-purple-600'}`}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-white">
                <path d="M5.223 2.25h13.554a.75.75 0 0 1 .678.427l2.443 5.145a.75.75 0 0 1 .072.323v.5c0 1.59-.81 2.994-2.04 3.815v8.29a.75.75 0 0 1-.75.75H4.82a.75.75 0 0 1-.75-.75v-8.29a4.41 4.41 0 0 1-2.04-3.815v-.5a.75.75 0 0 1 .072-.323l2.443-5.145a.75.75 0 0 1 .678-.427Z" />
              </svg>
            </div>
            <div>
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">{shop.name}</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">{shop.address}</p>
            </div>
          </div>
          {!shop.isApproved ? (
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 animate-pulse">
              ⏳ Pending Approval
            </span>
          ) : shop.isArchived ? (
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-200 dark:bg-zinc-700 text-gray-600 dark:text-gray-400">
              📦 Archived
            </span>
          ) : (
            <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${shop.isOpen ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'}`}>
              {shop.isOpen ? 'Open' : 'Closed'}
            </span>
          )}
        </div>

        {/* UPI Info */}
        <div className="bg-gray-50 dark:bg-zinc-800/50 rounded-lg p-3 mb-4">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">UPI Address</p>
          {upiMethod ? (
            <p className="text-sm font-mono font-bold text-indigo-600 dark:text-indigo-400">{upiMethod.upiId}</p>
          ) : (
            <p className="text-sm text-amber-500 italic">Not configured</p>
          )}
        </div>

        {/* Stats Grid — only show for approved shops that have data */}
        {shop.isApproved && (
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{shopOrders.length}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Total Orders</p>
            </div>
            <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-green-600 dark:text-green-400">₹{totalRevenue.toFixed(0)}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Revenue</p>
            </div>
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{activeOrders.length}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Active Orders</p>
            </div>
            <div className="bg-rose-50 dark:bg-rose-900/20 rounded-lg p-3 text-center">
              <p className="text-2xl font-bold text-rose-600 dark:text-rose-400">₹{pendingAmount.toFixed(0)}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Pending Due</p>
            </div>
          </div>
        )}

        {/* Pricing */}
        <div className="flex gap-2 text-xs text-gray-500 dark:text-gray-400 mb-4">
          <span className="bg-gray-100 dark:bg-zinc-800 px-2 py-1 rounded">B&W: ₹{shop.customPricing.bwPerPage}/pg</span>
          <span className="bg-gray-100 dark:bg-zinc-800 px-2 py-1 rounded">Color: ₹{shop.customPricing.colorPerPage}/pg</span>
        </div>
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800/50">
        {!shop.isApproved ? (
          /* Pending shop — Approve / Reject */
          <div className="flex gap-2">
            <Button
              onClick={handleApprove}
              variant="primary"
              size="sm"
              fullWidth
              disabled={isProcessing}
              className="!bg-gradient-to-r !from-emerald-500 !to-green-600 hover:!from-emerald-600 hover:!to-green-700"
              leftIcon={
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M19.916 4.626a.75.75 0 0 1 .208 1.04l-9 13.5a.75.75 0 0 1-1.154.114l-6-6a.75.75 0 0 1 1.06-1.06l5.353 5.353 8.493-12.74a.75.75 0 0 1 1.04-.207Z" clipRule="evenodd" />
                </svg>
              }
            >
              Approve
            </Button>
            <Button
              onClick={handleReject}
              variant="danger"
              size="sm"
              fullWidth
              disabled={isProcessing}
              leftIcon={
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M5.47 5.47a.75.75 0 0 1 1.06 0L12 10.94l5.47-5.47a.75.75 0 1 1 1.06 1.06L13.06 12l5.47 5.47a.75.75 0 1 1-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 0 1-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                </svg>
              }
            >
              Reject
            </Button>
          </div>
        ) : (
          /* Approved shop — archive + payout + delete */
          <div className="space-y-2">
            {!shop.isArchived && (
              <Button
                onClick={() => onCreatePayout(shop)}
                variant="primary"
                size="sm"
                fullWidth
                className="!bg-gradient-to-r !from-emerald-500 !to-green-600 hover:!from-emerald-600 hover:!to-green-700"
                leftIcon={
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                    <path d="M2.273 5.625A4.483 4.483 0 0 1 5.25 4.5h13.5c1.141 0 2.183.425 2.977 1.125A3 3 0 0 0 18.75 3H5.25a3 3 0 0 0-2.977 2.625ZM2.273 8.625A4.483 4.483 0 0 1 5.25 7.5h13.5c1.141 0 2.183.425 2.977 1.125A3 3 0 0 0 18.75 6H5.25a3 3 0 0 0-2.977 2.625ZM5.25 9a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h13.5a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3H15a.75.75 0 0 0-.75.75 2.25 2.25 0 0 1-4.5 0A.75.75 0 0 0 9 9H5.25Z" />
                  </svg>
                }
              >
                Send Payout
              </Button>
            )}
            <Button
              onClick={handleArchiveToggle}
              variant="secondary"
              size="sm"
              fullWidth
              disabled={isProcessing}
              leftIcon={
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path d="M3.375 3C2.339 3 1.5 3.84 1.5 4.875v.75c0 1.036.84 1.875 1.875 1.875h17.25c1.035 0 1.875-.84 1.875-1.875v-.75C22.5 3.839 21.66 3 20.625 3H3.375Z" />
                  <path fillRule="evenodd" d="m3.087 9 .54 9.176A3 3 0 0 0 6.62 21h10.757a3 3 0 0 0 2.995-2.824L20.913 9H3.087Zm6.163 3.75A.75.75 0 0 1 10 12h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1-.75-.75Z" clipRule="evenodd" />
                </svg>
              }
            >
              {shop.isArchived ? 'Unarchive Shop' : 'Archive Shop'}
            </Button>
            {!showDeleteConfirm ? (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="w-full text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 py-1 transition-colors"
              >
                Delete Shop & Owner Account
              </button>
            ) : (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3 border border-red-200 dark:border-red-800/30">
                <p className="text-xs text-red-600 dark:text-red-400 mb-2 font-medium">Are you sure? This will permanently delete the shop and owner account.</p>
                <div className="flex gap-2">
                  <Button onClick={handleDelete} variant="danger" size="sm" fullWidth disabled={isProcessing}>
                    Confirm Delete
                  </Button>
                  <Button onClick={() => setShowDeleteConfirm(false)} variant="ghost" size="sm" fullWidth>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
};

export default AdminShopCard;
