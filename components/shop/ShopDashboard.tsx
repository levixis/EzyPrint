
import React, { useState, useMemo } from 'react';
import { useAppContext } from '../../contexts/AppContext';
import { DocumentOrder, OrderStatus, ShopPricing, PayoutMethod, PayoutStatus } from '../../types';
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
  const [selectedOrder, setSelectedOrder] = useState<DocumentOrder | null>(null);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [disputePayoutId, setDisputePayoutId] = useState<string | null>(null);
  const [disputeNote, setDisputeNote] = useState('');
  const [payoutRequestAmount, setPayoutRequestAmount] = useState('');
  const [payoutRequestNote, setPayoutRequestNote] = useState('');
  const [isRequestingPayout, setIsRequestingPayout] = useState(false);
  const [showPayoutRequestForm, setShowPayoutRequestForm] = useState(false);
  const [activeTab, setActiveTab] = useState<'orders' | 'financials'>('orders');

  const dashboardRef = useRef<HTMLDivElement>(null);

  const allShopOrders = getOrdersForCurrentUser();
  const shopProfile = useMemo(() => getShopById(shopId), [shopId, getShopById]);
  const shopPayouts = payouts.filter(p => p.shopId === shopId);

  const totalEarned = useMemo(() => {
    return allShopOrders
      .filter(o => o.status === OrderStatus.COMPLETED)
      .reduce((sum, order) => sum + (order.priceDetails?.pageCost || 0), 0);
  }, [allShopOrders]);

  const totalPaidOut = useMemo(() => {
    return shopPayouts
      .filter(p => p.status === PayoutStatus.PAID || p.status === PayoutStatus.CONFIRMED)
      .reduce((sum, payout) => sum + payout.amount, 0);
  }, [shopPayouts]);

  const redeemableAmount = Math.max(0, totalEarned - totalPaidOut);

  useGSAP(() => {
    gsap.set(".dashboard-item", { opacity: 1, y: 0 });
  }, { scope: dashboardRef });

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

  const shopRelevantOrders = allShopOrders.filter(o => o.status !== OrderStatus.PENDING_PAYMENT && o.status !== OrderStatus.PAYMENT_FAILED);

  if (!shopProfile) {
    return <p className="text-status-error text-center p-5">Shop profile not found. Please contact support.</p>;
  }

  // Pending approval gate — block full dashboard access until admin approves
  if (!shopProfile.isApproved) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] py-12 px-4">
        <div className="w-full max-w-md">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-amber-200 dark:border-amber-800/40 overflow-hidden">
            {/* Header */}
            <div className="bg-gradient-to-r from-amber-400 to-orange-500 p-6 text-center">
              <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-white">
                  <path fillRule="evenodd" d="M12 1.5a5.25 5.25 0 0 0-5.25 5.25v3a3 3 0 0 0-3 3v6.75a3 3 0 0 0 3 3h10.5a3 3 0 0 0 3-3v-6.75a3 3 0 0 0-3-3v-3c0-2.9-2.35-5.25-5.25-5.25Zm3.75 8.25v-3a3.75 3.75 0 1 0-7.5 0v3h7.5Z" clipRule="evenodd" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-white">Pending Admin Approval</h2>
              <p className="text-white/80 text-sm mt-1">Your shop registration is under review</p>
            </div>

            {/* Body */}
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
                  The admin needs to verify and approve your shop before you can start accepting orders and managing settings.
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  You'll be able to access your full dashboard once approved. This page will update automatically.
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

  return (
    <div ref={dashboardRef} className="space-y-8 pt-28">
      <div className="flex justify-between items-center mb-6 dashboard-item">
        <div>
          <h2 className="text-3xl font-bold text-gray-900 dark:text-white">Shop Dashboard: {shopProfile.name}</h2>
          <p className="text-gray-600 dark:text-gray-400 text-sm">{shopProfile.address} - {shopProfile.isOpen ? <span className="text-status-success font-semibold">Open for Orders</span> : <span className="text-status-error font-semibold">Currently Closed</span>}</p>
        </div>
        <Button onClick={handleOpenSettingsModal} variant="secondary" size="md"
          leftIcon={<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 0 1 1.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.108 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.11v1.093c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.27.96-.12 1.45l-.773.773a1.125 1.125 0 0 1-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.78.93l-.15.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.149-.894c-.07-.424-.384-.764-.78-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-.96.27-1.45-.12l-.773-.774a1.125 1.125 0 0 1-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.506-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.11v-1.094c0-.55.398-1.019.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.107-1.204l-.527-.738a1.125 1.125 0 0 1 .12-1.45l.773-.773a1.125 1.125 0 0 1 1.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.93l.15-.894Z" /></svg>}
        >
          Shop Settings
        </Button>
      </div>

      <div className="flex border-b border-gray-200 dark:border-zinc-700 mb-6 dashboard-item gap-6">
        <button
          onClick={() => setActiveTab('orders')}
          className={`pb-3 text-lg font-medium transition-colors border-b-2 hover:text-brand-primary focus:outline-none ${activeTab === 'orders' ? 'border-brand-primary text-brand-primary' : 'border-transparent text-gray-500 dark:text-gray-400'}`}
        >
          Active Orders
        </button>
        <button
          onClick={() => setActiveTab('financials')}
          className={`pb-3 text-lg font-medium transition-colors border-b-2 hover:text-brand-primary focus:outline-none ${activeTab === 'financials' ? 'border-brand-primary text-brand-primary' : 'border-transparent text-gray-500 dark:text-gray-400'}`}
        >
          Financials & Payouts
        </button>
      </div>

      {activeTab === 'financials' && (
        <div className="space-y-6 dashboard-item animation-fade-in">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-white dark:bg-zinc-900 shadow-md border border-gray-200 dark:border-zinc-700 p-6 rounded-2xl flex flex-col items-center justify-center text-center backdrop-blur-sm">
              <span className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Total Shop Earnings</span>
              <span className="text-3xl font-bold text-gray-800 dark:text-gray-100">₹{totalEarned.toFixed(2)}</span>
            </div>
            <div className="bg-white dark:bg-zinc-900 shadow-md border border-gray-200 dark:border-zinc-700 p-6 rounded-2xl flex flex-col items-center justify-center text-center backdrop-blur-sm">
              <span className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Total Paid Out</span>
              <span className="text-3xl font-bold text-brand-primary">₹{totalPaidOut.toFixed(2)}</span>
            </div>
            <div className="bg-gradient-to-br from-emerald-500 to-green-600 shadow-lg border border-emerald-400/50 p-6 rounded-2xl flex flex-col items-center justify-center text-center transform hover:scale-[1.02] transition-transform">
              <span className="text-sm font-medium text-emerald-50 mb-1">Redeemable Amount</span>
              <span className="text-4xl font-extrabold text-white tracking-tight">₹{redeemableAmount.toFixed(2)}</span>
            </div>
          </div>

          {/* Request Payout Section */}
          <div className="dashboard-item">
            <Card title="" className="bg-white dark:bg-zinc-900 shadow-lg border border-gray-200 dark:border-zinc-700 overflow-hidden !p-0">
              <div className="bg-gradient-to-r from-indigo-500 to-purple-600 p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white">
                        <path d="M12 7.5a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5Z" />
                        <path fillRule="evenodd" d="M1.5 4.875C1.5 3.839 2.34 3 3.375 3h17.25c1.035 0 1.875.84 1.875 1.875v9.75c0 1.036-.84 1.875-1.875 1.875H3.375A1.875 1.875 0 0 1 1.5 14.625v-9.75ZM8.25 9.75a3.75 3.75 0 1 1 7.5 0 3.75 3.75 0 0 1-7.5 0ZM18.75 9a.75.75 0 0 0-.75.75v.008c0 .414.336.75.75.75h.008a.75.75 0 0 0 .75-.75V9.75a.75.75 0 0 0-.75-.75h-.008ZM4.5 9.75A.75.75 0 0 1 5.25 9h.008a.75.75 0 0 1 .75.75v.008a.75.75 0 0 1-.75.75H5.25a.75.75 0 0 1-.75-.75V9.75Z" clipRule="evenodd" />
                        <path d="M2.25 18a.75.75 0 0 0 0 1.5c5.4 0 10.63.722 15.6 2.075 1.19.324 2.4-.558 2.4-1.82V18.75a.75.75 0 0 0-.75-.75H2.25Z" />
                      </svg>
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-white">Request Payout</h3>
                      <p className="text-indigo-100 text-xs">Withdraw your earnings</p>
                    </div>
                  </div>
                  {!showPayoutRequestForm && (
                    <Button
                      onClick={() => setShowPayoutRequestForm(true)}
                      variant="secondary"
                      size="sm"
                      disabled={redeemableAmount <= 0}
                      className="!bg-white/20 !text-white !border-white/30 hover:!bg-white/30 backdrop-blur-sm"
                    >
                      {redeemableAmount > 0 ? '+ New Request' : 'No Balance'}
                    </Button>
                  )}
                </div>
              </div>

              <div className="p-5">
                {redeemableAmount <= 0 && !showPayoutRequestForm ? (
                  <p className="text-gray-500 dark:text-gray-400 text-sm text-center py-4">
                    No redeemable balance available. Complete more orders to earn.
                  </p>
                ) : showPayoutRequestForm ? (
                  <div className="space-y-4">
                    <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/30 rounded-xl p-4">
                      <p className="text-sm text-indigo-700 dark:text-indigo-300">
                        Available balance: <strong className="text-lg">₹{redeemableAmount.toFixed(2)}</strong>
                      </p>
                    </div>
                    <div>
                      <label htmlFor="payoutAmount" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Amount (₹)</label>
                      <input
                        id="payoutAmount"
                        type="number"
                        min="1"
                        max={redeemableAmount}
                        step="0.01"
                        value={payoutRequestAmount}
                        onChange={(e) => setPayoutRequestAmount(e.target.value)}
                        placeholder={`Max ₹${redeemableAmount.toFixed(2)}`}
                        className="w-full p-3 rounded-lg bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-600 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-shadow"
                      />
                    </div>
                    <div>
                      <label htmlFor="payoutNote" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Note (optional)</label>
                      <textarea
                        id="payoutNote"
                        value={payoutRequestNote}
                        onChange={(e) => setPayoutRequestNote(e.target.value)}
                        placeholder="e.g., UPI transfer preferred, monthly settlement..."
                        className="w-full p-3 rounded-lg bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-600 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-shadow"
                        rows={2}
                      />
                    </div>
                    <div className="flex gap-3">
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
                    Click "+ New Request" to withdraw your balance.
                  </p>
                )}
              </div>
            </Card>
          </div>

      {shopPayouts.length > 0 && (
        <div className="dashboard-item">
          <Card title="Payouts from Admin" className="bg-white dark:bg-zinc-900 shadow-lg border border-gray-200 dark:border-zinc-700">
            <div className="space-y-3">
              {shopPayouts.map(payout => (
                <div key={payout.id} className={`rounded-xl p-4 border ${getPayoutStatusStyle(payout.status)}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-white/50 dark:bg-black/20 flex items-center justify-center">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                          <path d="M2.273 5.625A4.483 4.483 0 0 1 5.25 4.5h13.5c1.141 0 2.183.425 2.977 1.125A3 3 0 0 0 18.75 3H5.25a3 3 0 0 0-2.977 2.625ZM2.273 8.625A4.483 4.483 0 0 1 5.25 7.5h13.5c1.141 0 2.183.425 2.977 1.125A3 3 0 0 0 18.75 6H5.25a3 3 0 0 0-2.977 2.625ZM5.25 9a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h13.5a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3H15a.75.75 0 0 0-.75.75 2.25 2.25 0 0 1-4.5 0A.75.75 0 0 0 9 9H5.25Z" />
                        </svg>
                      </div>
                      <div>
                        <p className="font-bold text-lg">₹{payout.amount.toFixed(2)}</p>
                        <p className="text-xs opacity-75">{new Date(payout.createdAt).toLocaleDateString()} • {payout.status}</p>
                      </div>
                    </div>
                    <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-white/30 dark:bg-black/20">
                      {payout.status}
                    </span>
                  </div>
                  {payout.adminNote && (
                    <p className="text-sm opacity-80 mb-3">Note: {payout.adminNote}</p>
                  )}

                  {/* Actions for PAID payouts — shopkeeper needs to confirm */}
                  {payout.status === PayoutStatus.PAID && (
                    <div className="flex gap-2 mt-3">
                      <Button
                        onClick={() => handleConfirmPayout(payout.id)}
                        variant="primary"
                        size="sm"
                        className="!bg-gradient-to-r !from-emerald-500 !to-green-600 hover:!from-emerald-600 hover:!to-green-700 flex-1"
                      >
                        ✓ Confirm Received
                      </Button>
                      <Button
                        onClick={() => setDisputePayoutId(payout.id)}
                        variant="danger"
                        size="sm"
                        className="flex-1"
                      >
                        ✕ Dispute
                      </Button>
                    </div>
                  )}

                  {/* Dispute form */}
                  {disputePayoutId === payout.id && (
                    <div className="mt-3 space-y-2">
                      <textarea
                        value={disputeNote}
                        onChange={(e) => setDisputeNote(e.target.value)}
                        placeholder="Explain why you're disputing this payout..."
                        className="w-full p-3 rounded-lg bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-600 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                        rows={3}
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
          </Card>
        </div>
      )}
        </div>
      )}

      {activeTab === 'orders' && (
        <div className="dashboard-item animation-fade-in">
          <Card title="Incoming & Active Orders" className="bg-white dark:bg-zinc-900 shadow-lg border border-gray-200 dark:border-zinc-700">
            {shopRelevantOrders.length > 0 ? (
              <ShopOrderList orders={shopRelevantOrders} onSelectOrder={handleSelectOrder} />
            ) : (
              <p className="text-gray-600 dark:text-gray-400 text-center py-4">No orders requiring shop attention at the moment. Good job!</p>
            )}
          </Card>
        </div>
      )}


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
