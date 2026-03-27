
import React, { useState, useMemo } from 'react';
import { useAppContext } from '../../contexts/AppContext';
import { OrderStatus, ShopPricing, PayoutMethod, PayoutStatus } from '../../types';
import ShopOrderList from './ShopOrderList';
import ShopOrderDetailsModal from './ShopOrderDetailsModal';
import ShopSettingsModal from './ShopSettingsModal';
import { Card } from '../common/Card';
import { Button } from '../common/Button';

interface ShopDashboardProps {
  shopId: string;
}

import { useRef } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';

const ShopDashboard: React.FC<ShopDashboardProps> = ({ shopId }) => {
  const { getOrdersForCurrentUser, updateOrderStatus, getShopById, updateShopSettings, payouts, requestPayout, confirmPayout, disputePayout } = useAppContext();
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [disputePayoutId, setDisputePayoutId] = useState<string | null>(null);
  const [disputeNote, setDisputeNote] = useState('');
  const [payoutRequestAmount, setPayoutRequestAmount] = useState('');
  const [payoutRequestNote, setPayoutRequestNote] = useState('');
  const [isRequestingPayout, setIsRequestingPayout] = useState(false);
  const [showPayoutRequestForm, setShowPayoutRequestForm] = useState(false);
  const [activeTab, setActiveTab] = useState<'orders' | 'earnings' | 'payouts'>('orders');

  const dashboardRef = useRef<HTMLDivElement>(null);

  const allShopOrders = getOrdersForCurrentUser();

  // Derive selectedOrder from live orders so it always reflects real-time Firestore data
  const selectedOrder = useMemo(() => {
    if (!selectedOrderId) return null;
    return allShopOrders.find(o => o.id === selectedOrderId) || null;
  }, [selectedOrderId, allShopOrders]);
  const shopProfile = useMemo(() => getShopById(shopId), [shopId, getShopById]);
  const shopPayouts = payouts.filter(p => p.shopId === shopId);

  // --- Computed Stats ---
  const completedOrders = useMemo(() =>
    allShopOrders.filter(o => o.status === OrderStatus.COMPLETED), [allShopOrders]);

  const totalEarned = useMemo(() =>
    completedOrders.reduce((sum, order) => sum + (order.priceDetails?.pageCost || 0), 0),
    [completedOrders]);

  const totalPaidOut = useMemo(() =>
    shopPayouts
      .filter(p => p.status === PayoutStatus.PAID || p.status === PayoutStatus.CONFIRMED)
      .reduce((sum, payout) => sum + payout.amount, 0),
    [shopPayouts]);

  const redeemableAmount = Math.max(0, totalEarned - totalPaidOut);

  // Time-based earnings
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const todayEarnings = useMemo(() =>
    completedOrders
      .filter(o => new Date(o.uploadedAt) >= todayStart)
      .reduce((sum, o) => sum + (o.priceDetails?.pageCost || 0), 0),
    [completedOrders, todayStart]);

  const weekEarnings = useMemo(() =>
    completedOrders
      .filter(o => new Date(o.uploadedAt) >= weekStart)
      .reduce((sum, o) => sum + (o.priceDetails?.pageCost || 0), 0),
    [completedOrders, weekStart]);

  const monthEarnings = useMemo(() =>
    completedOrders
      .filter(o => new Date(o.uploadedAt) >= monthStart)
      .reduce((sum, o) => sum + (o.priceDetails?.pageCost || 0), 0),
    [completedOrders, monthStart]);

  // Active orders count
  const pendingOrders = allShopOrders.filter(o =>
    o.status === OrderStatus.PENDING_APPROVAL
  );
  const activeOrders = allShopOrders.filter(o =>
    [OrderStatus.PENDING_APPROVAL, OrderStatus.PRINTING, OrderStatus.READY_FOR_PICKUP].includes(o.status)
  );

  // Recent completed orders for earnings tab
  const recentCompleted = useMemo(() =>
    completedOrders
      .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
      .slice(0, 10),
    [completedOrders]);

  useGSAP(() => {
    gsap.set(".dashboard-item", { opacity: 1, y: 0 });
  }, { scope: dashboardRef });

  const handleSelectOrder = (orderId: string) => {
    setSelectedOrderId(orderId);
  };

  const handleCloseModal = () => setSelectedOrderId(null);
  const handleOpenSettingsModal = () => setIsSettingsModalOpen(true);
  const handleCloseSettingsModal = () => setIsSettingsModalOpen(false);

  const handleSaveShopSettings = (sId: string, newSettings: { pricing: ShopPricing; isOpen: boolean; payoutMethods?: PayoutMethod[] }) => {
    updateShopSettings(sId, newSettings);
  };

  const handleConfirmPayout = async (payoutId: string) => {
    await confirmPayout(payoutId);
  };

  const handleDisputePayout = async () => {
    if (disputePayoutId && disputeNote.trim()) {
      await disputePayout(disputePayoutId, disputeNote.trim());
      setDisputePayoutId(null);
      setDisputeNote('');
    }
  };

  const shopRelevantOrders = allShopOrders.filter(o => o.status !== OrderStatus.PENDING_PAYMENT && o.status !== OrderStatus.PAYMENT_FAILED && o.status !== OrderStatus.CANCELLED);

  if (!shopProfile) {
    return <p className="text-status-error text-center p-5">Shop profile not found. Please contact support.</p>;
  }

  // Pending approval gate
  if (!shopProfile.isApproved) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] py-12 px-4">
        <div className="w-full max-w-md">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-amber-200 dark:border-amber-800/40 overflow-hidden">
            <div className="bg-gradient-to-r from-amber-400 to-orange-500 p-6 text-center">
              <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-white">
                  <path fillRule="evenodd" d="M12 1.5a5.25 5.25 0 0 0-5.25 5.25v3a3 3 0 0 0-3 3v6.75a3 3 0 0 0 3 3h10.5a3 3 0 0 0 3-3v-6.75a3 3 0 0 0-3-3v-3c0-2.9-2.35-5.25-5.25-5.25Zm3.75 8.25v-3a3.75 3.75 0 1 0-7.5 0v3h7.5Z" clipRule="evenodd" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-white">Pending Admin Approval</h2>
              <p className="text-white/80 text-sm mt-1">Your shop registration is under review</p>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 rounded-xl p-4">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white">
                      <path d="M5.223 2.25h13.554a.75.75 0 0 1 .678.427l2.443 5.145a.75.75 0 0 1 .072.323v.5c0 1.59-.81 2.994-2.04 3.815v8.29a.75.75 0 0 1-.75.75H4.82a.75.75 0 0 1-.75-.75v-8.29a4.41 4.41 0 0 1-2.04-3.815v-.5a.75.75 0 0 1 .072-.323l2.443-5.145a.75.75 0 0 1 .678-.427Z" />
                    </svg>
                  </div>
                  <div>
                    <p className="font-bold text-gray-900 dark:text-white">{shopProfile.name}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{shopProfile.address}</p>
                  </div>
                </div>
              </div>
              <div className="text-center space-y-2">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  The admin needs to verify and approve your shop before you can start accepting orders.
                </p>
              </div>
              <div className="flex items-center gap-2 justify-center text-amber-600 dark:text-amber-400">
                <svg className="w-5 h-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span className="text-sm font-medium">Awaiting approval...</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const getPayoutStatusStyle = (status: PayoutStatus) => {
    switch (status) {
      case PayoutStatus.PENDING: return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700';
      case PayoutStatus.PAID: return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-300 dark:border-blue-700';
      case PayoutStatus.CONFIRMED: return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700';
      case PayoutStatus.DISPUTED: return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-300 dark:border-red-700';
      default: return 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400 border-gray-300 dark:border-zinc-700';
    }
  };

  const tabs = [
    { key: 'orders' as const, label: 'Orders', badge: pendingOrders.length > 0 ? pendingOrders.length : undefined },
    { key: 'earnings' as const, label: 'Earnings' },
    { key: 'payouts' as const, label: 'Payouts', badge: shopPayouts.filter(p => p.status === PayoutStatus.PAID).length > 0 ? shopPayouts.filter(p => p.status === PayoutStatus.PAID).length : undefined },
  ];

  return (
    <div ref={dashboardRef} className="space-y-5 pt-20 sm:pt-28 pb-6">
      {/* Compact header with settings */}
      <div className="flex justify-between items-start dashboard-item">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-xl sm:text-3xl font-bold text-gray-900 dark:text-white truncate">{shopProfile.name}</h2>
            <span className={`flex-shrink-0 w-2.5 h-2.5 rounded-full ${shopProfile.isOpen ? 'bg-emerald-500' : 'bg-red-500'}`} title={shopProfile.isOpen ? 'Open' : 'Closed'} />
          </div>
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 truncate">{shopProfile.address}</p>
        </div>
        <button
          onClick={handleOpenSettingsModal}
          className="flex-shrink-0 p-2.5 rounded-xl bg-gray-100 dark:bg-zinc-800 hover:bg-gray-200 dark:hover:bg-zinc-700 text-gray-600 dark:text-gray-400 transition-colors"
          title="Shop Settings"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
        </button>
      </div>

      {/* Quick Stats Bar — always visible */}
      <div className="grid grid-cols-3 gap-2.5 sm:gap-4 dashboard-item">
        <div className="bg-white dark:bg-zinc-900 rounded-xl sm:rounded-2xl p-3 sm:p-4 border border-gray-200 dark:border-zinc-700 shadow-sm text-center">
          <div className="relative inline-block">
            <p className="text-2xl sm:text-3xl font-bold text-brand-primary">{activeOrders.length}</p>
            {pendingOrders.length > 0 && (
              <span className="absolute -top-1 -right-4 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center animate-pulse">
                {pendingOrders.length}
              </span>
            )}
          </div>
          <p className="text-[10px] sm:text-xs text-gray-500 dark:text-gray-400 mt-0.5">Active Orders</p>
        </div>
        <div className="bg-white dark:bg-zinc-900 rounded-xl sm:rounded-2xl p-3 sm:p-4 border border-gray-200 dark:border-zinc-700 shadow-sm text-center">
          <p className="text-2xl sm:text-3xl font-bold text-emerald-600 dark:text-emerald-400">₹{todayEarnings.toFixed(0)}</p>
          <p className="text-[10px] sm:text-xs text-gray-500 dark:text-gray-400 mt-0.5">Today</p>
        </div>
        <div className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl sm:rounded-2xl p-3 sm:p-4 shadow-md text-center">
          <p className="text-2xl sm:text-3xl font-bold text-white">₹{redeemableAmount.toFixed(0)}</p>
          <p className="text-[10px] sm:text-xs text-indigo-100 mt-0.5">Redeemable</p>
        </div>
      </div>

      {/* 3-Tab Navigation */}
      <div className="flex bg-gray-100 dark:bg-zinc-800/80 rounded-xl p-1 gap-1 dashboard-item">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 relative py-2.5 px-3 text-sm font-medium rounded-lg transition-all duration-200
              ${activeTab === tab.key
                ? 'bg-white dark:bg-zinc-900 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
          >
            {tab.label}
            {tab.badge && (
              <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ===== ORDERS TAB ===== */}
      {activeTab === 'orders' && (
        <div className="dashboard-item animation-fade-in">
          {shopRelevantOrders.length > 0 ? (
            <ShopOrderList orders={shopRelevantOrders} onSelectOrder={handleSelectOrder} />
          ) : (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-8 h-8 text-emerald-600 dark:text-emerald-400">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
              </div>
              <p className="text-gray-600 dark:text-gray-400 text-lg font-medium">All caught up!</p>
              <p className="text-gray-400 dark:text-gray-500 text-sm mt-1">No orders requiring attention</p>
            </div>
          )}
        </div>
      )}

      {/* ===== EARNINGS TAB ===== */}
      {activeTab === 'earnings' && (
        <div className="space-y-5 dashboard-item animation-fade-in">
          {/* Earnings grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-700">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Today</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">₹{todayEarnings.toFixed(2)}</p>
            </div>
            <div className="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-700">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">This Week</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">₹{weekEarnings.toFixed(2)}</p>
            </div>
            <div className="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-700">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">This Month</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">₹{monthEarnings.toFixed(2)}</p>
            </div>
            <div className="bg-white dark:bg-zinc-900 rounded-xl p-4 border border-gray-200 dark:border-zinc-700">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">All Time</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">₹{totalEarned.toFixed(2)}</p>
            </div>
          </div>

          {/* Summary stats */}
          <div className="bg-gradient-to-r from-emerald-500 to-green-600 rounded-xl p-4 sm:p-5 shadow-md">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-emerald-50 text-xs mb-0.5">Total Orders Completed</p>
                <p className="text-3xl font-extrabold text-white">{completedOrders.length}</p>
              </div>
              <div className="text-right">
                <p className="text-emerald-50 text-xs mb-0.5">Avg. Order Value</p>
                <p className="text-2xl font-bold text-white">
                  ₹{completedOrders.length > 0 ? (totalEarned / completedOrders.length).toFixed(0) : '0'}
                </p>
              </div>
            </div>
          </div>

          {/* Recent completed orders */}
          {recentCompleted.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Recent Completed</h3>
              <div className="space-y-2">
                {recentCompleted.map(order => (
                  <button
                    key={order.id}
                    onClick={() => handleSelectOrder(order.id)}
                    className="w-full flex items-center justify-between p-3 bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-700 hover:border-brand-primary/50 transition-colors text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                        Order #{order.id.slice(-6)}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {new Date(order.uploadedAt).toLocaleDateString()} • {order.printOptions.pages} pages
                      </p>
                    </div>
                    <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400 ml-3 flex-shrink-0">
                      +₹{order.priceDetails.pageCost.toFixed(2)}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== PAYOUTS TAB ===== */}
      {activeTab === 'payouts' && (
        <div className="space-y-5 dashboard-item animation-fade-in">
          {/* Balance overview */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white dark:bg-zinc-900 rounded-xl p-3 border border-gray-200 dark:border-zinc-700 text-center">
              <p className="text-[10px] sm:text-xs text-gray-500 dark:text-gray-400">Earned</p>
              <p className="text-lg font-bold text-gray-800 dark:text-gray-100">₹{totalEarned.toFixed(0)}</p>
            </div>
            <div className="bg-white dark:bg-zinc-900 rounded-xl p-3 border border-gray-200 dark:border-zinc-700 text-center">
              <p className="text-[10px] sm:text-xs text-gray-500 dark:text-gray-400">Paid Out</p>
              <p className="text-lg font-bold text-brand-primary">₹{totalPaidOut.toFixed(0)}</p>
            </div>
            <div className="bg-gradient-to-br from-emerald-500 to-green-600 rounded-xl p-3 text-center shadow-sm">
              <p className="text-[10px] sm:text-xs text-emerald-50">Available</p>
              <p className="text-lg font-extrabold text-white">₹{redeemableAmount.toFixed(0)}</p>
            </div>
          </div>

          {/* Request Payout */}
          <Card title="" className="bg-white dark:bg-zinc-900 shadow-md border border-gray-200 dark:border-zinc-700 overflow-hidden !p-0">
            <div className="bg-gradient-to-r from-indigo-500 to-purple-600 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-lg bg-white/20 backdrop-blur-sm flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4.5 h-4.5 text-white">
                      <path d="M12 7.5a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5Z" />
                      <path fillRule="evenodd" d="M1.5 4.875C1.5 3.839 2.34 3 3.375 3h17.25c1.035 0 1.875.84 1.875 1.875v9.75c0 1.036-.84 1.875-1.875 1.875H3.375A1.875 1.875 0 0 1 1.5 14.625v-9.75ZM8.25 9.75a3.75 3.75 0 1 1 7.5 0 3.75 3.75 0 0 1-7.5 0ZM18.75 9a.75.75 0 0 0-.75.75v.008c0 .414.336.75.75.75h.008a.75.75 0 0 0 .75-.75V9.75a.75.75 0 0 0-.75-.75h-.008ZM4.5 9.75A.75.75 0 0 1 5.25 9h.008a.75.75 0 0 1 .75.75v.008a.75.75 0 0 1-.75.75H5.25a.75.75 0 0 1-.75-.75V9.75Z" clipRule="evenodd" />
                      <path d="M2.25 18a.75.75 0 0 0 0 1.5c5.4 0 10.63.722 15.6 2.075 1.19.324 2.4-.558 2.4-1.82V18.75a.75.75 0 0 0-.75-.75H2.25Z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-white">Request Payout</h3>
                    <p className="text-indigo-100 text-[10px]">Withdraw your earnings</p>
                  </div>
                </div>
                {!showPayoutRequestForm && (
                  <Button
                    onClick={() => setShowPayoutRequestForm(true)}
                    variant="secondary"
                    size="sm"
                    disabled={redeemableAmount <= 0}
                    className="!bg-white/20 !text-white !border-white/30 hover:!bg-white/30 backdrop-blur-sm !text-xs"
                  >
                    {redeemableAmount > 0 ? '+ New' : 'No Balance'}
                  </Button>
                )}
              </div>
            </div>

            <div className="p-4">
              {redeemableAmount <= 0 && !showPayoutRequestForm ? (
                <p className="text-gray-500 dark:text-gray-400 text-sm text-center py-3">
                  No redeemable balance. Complete more orders to earn.
                </p>
              ) : showPayoutRequestForm ? (
                <div className="space-y-3">
                  <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/30 rounded-lg p-3">
                    <p className="text-sm text-indigo-700 dark:text-indigo-300">
                      Available: <strong className="text-base">₹{redeemableAmount.toFixed(2)}</strong>
                    </p>
                  </div>
                  <div>
                    <label htmlFor="payoutAmount" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Amount (₹)</label>
                    <input
                      id="payoutAmount"
                      type="number"
                      min="1"
                      max={redeemableAmount}
                      step="0.01"
                      value={payoutRequestAmount}
                      onChange={(e) => setPayoutRequestAmount(e.target.value)}
                      placeholder={`Max ₹${redeemableAmount.toFixed(2)}`}
                      className="w-full p-2.5 rounded-lg bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-600 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label htmlFor="payoutNote" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Note (optional)</label>
                    <textarea
                      id="payoutNote"
                      value={payoutRequestNote}
                      onChange={(e) => setPayoutRequestNote(e.target.value)}
                      placeholder="e.g., UPI transfer preferred..."
                      className="w-full p-2.5 rounded-lg bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-600 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      rows={2}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={async () => {
                        const amount = parseFloat(payoutRequestAmount);
                        if (!amount || amount <= 0 || amount > redeemableAmount) return;
                        setIsRequestingPayout(true);
                        const result = await requestPayout(shopId, shopProfile?.name || '', amount, payoutRequestNote.trim() || undefined);
                        setIsRequestingPayout(false);
                        if (result.success) {
                          setPayoutRequestAmount('');
                          setPayoutRequestNote('');
                          setShowPayoutRequestForm(false);
                        }
                      }}
                      variant="primary"
                      size="md"
                      disabled={isRequestingPayout || !payoutRequestAmount || parseFloat(payoutRequestAmount) <= 0 || parseFloat(payoutRequestAmount) > redeemableAmount}
                      className="flex-1 !bg-gradient-to-r !from-indigo-500 !to-purple-600 hover:!from-indigo-600 hover:!to-purple-700"
                    >
                      {isRequestingPayout ? 'Submitting...' : `Request ₹${parseFloat(payoutRequestAmount || '0').toFixed(2)}`}
                    </Button>
                    <Button
                      onClick={() => {
                        setShowPayoutRequestForm(false);
                        setPayoutRequestAmount('');
                        setPayoutRequestNote('');
                      }}
                      variant="ghost"
                      size="md"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-gray-500 dark:text-gray-400 text-sm text-center py-2">
                  Click "+ New" to withdraw your balance.
                </p>
              )}
            </div>
          </Card>

          {/* Payout History */}
          {shopPayouts.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Payout History</h3>
              <div className="space-y-2.5">
                {shopPayouts.map(payout => (
                  <div key={payout.id} className={`rounded-xl p-3.5 border ${getPayoutStatusStyle(payout.status)}`}>
                    <div className="flex items-center justify-between mb-1">
                      <p className="font-bold text-base">₹{payout.amount.toFixed(2)}</p>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/30 dark:bg-black/20 uppercase">
                        {payout.status}
                      </span>
                    </div>
                    <p className="text-[11px] opacity-75">{new Date(payout.createdAt).toLocaleDateString()}</p>
                    {payout.adminNote && (
                      <p className="text-xs opacity-80 mt-1.5">Note: {payout.adminNote}</p>
                    )}

                    {payout.status === PayoutStatus.PAID && (
                      <div className="flex gap-2 mt-2.5">
                        <Button
                          onClick={() => handleConfirmPayout(payout.id)}
                          variant="primary"
                          size="sm"
                          className="!bg-gradient-to-r !from-emerald-500 !to-green-600 hover:!from-emerald-600 hover:!to-green-700 flex-1 !text-xs"
                        >
                          ✓ Confirm
                        </Button>
                        <Button
                          onClick={() => setDisputePayoutId(payout.id)}
                          variant="danger"
                          size="sm"
                          className="flex-1 !text-xs"
                        >
                          ✕ Dispute
                        </Button>
                      </div>
                    )}

                    {disputePayoutId === payout.id && (
                      <div className="mt-2.5 space-y-2">
                        <textarea
                          value={disputeNote}
                          onChange={(e) => setDisputeNote(e.target.value)}
                          placeholder="Explain why you're disputing..."
                          className="w-full p-2.5 rounded-lg bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-600 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                          rows={2}
                        />
                        <div className="flex gap-2">
                          <Button onClick={handleDisputePayout} variant="danger" size="sm" disabled={!disputeNote.trim()}>
                            Submit Dispute
                          </Button>
                          <Button onClick={() => { setDisputePayoutId(null); setDisputeNote(''); }} variant="ghost" size="sm">
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
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
