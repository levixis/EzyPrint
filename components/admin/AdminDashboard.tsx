import React, { useState, useMemo, useRef } from 'react';
import { useAppContext } from '../../contexts/AppContext';
import { ShopProfile, OrderStatus, PayoutStatus } from '../../types';
import AdminShopCard from './AdminShopCard';
import AdminPayoutModal from './AdminPayoutModal';
import { Card } from '../common/Card';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';

type AdminTab = 'overview' | 'shops' | 'payouts' | 'orders';

const AdminDashboard: React.FC = () => {
  const { shops, allOrders, payouts } = useAppContext();
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const [selectedShopForPayout, setSelectedShopForPayout] = useState<ShopProfile | null>(null);
  const [ordersSearch, setOrdersSearch] = useState('');
  const [ordersShopFilter, setOrdersShopFilter] = useState<string>('all');
  const [payoutsShopFilter, setPayoutsShopFilter] = useState<string>('all');
  const [ordersLimit, setOrdersLimit] = useState(50);
  const dashboardRef = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    gsap.from(".admin-card", {
      y: 20,
      opacity: 0,
      duration: 0.6,
      stagger: 0.08,
      ease: "power3.out",
    });
  }, { scope: dashboardRef, dependencies: [activeTab] });

  // Helper: check if an order has been paid (post-payment-verification)
  const isPaidStatus = (status: OrderStatus) =>
    status === OrderStatus.PENDING_APPROVAL ||
    status === OrderStatus.PRINTING ||
    status === OrderStatus.READY_FOR_PICKUP ||
    status === OrderStatus.COMPLETED;

  // Computed stats
  const stats = useMemo(() => {
    const totalOrders = allOrders.length;
    const paidOrders = allOrders.filter(o => isPaidStatus(o.status));
    const totalRevenue = paidOrders.reduce((sum, o) => sum + o.priceDetails.totalPrice, 0);
    const shopEarnings = paidOrders.reduce((sum, o) => sum + o.priceDetails.pageCost, 0);
    const platformFees = paidOrders.reduce((sum, o) => sum + o.priceDetails.baseFee, 0);
    const activeOrders = allOrders.filter(o =>
      o.status !== OrderStatus.COMPLETED &&
      o.status !== OrderStatus.CANCELLED &&
      o.status !== OrderStatus.PAYMENT_FAILED &&
      o.status !== OrderStatus.PENDING_PAYMENT
    ).length;
    const pendingPayouts = payouts.filter(p => p.status === PayoutStatus.PENDING).length;
    const disputedPayouts = payouts.filter(p => p.status === PayoutStatus.DISPUTED).length;
    const totalPaidOut = payouts
      .filter(p => p.status === PayoutStatus.CONFIRMED || p.status === PayoutStatus.PAID)
      .reduce((sum, p) => sum + p.amount, 0);

    const pendingApprovals = shops.filter(s => !s.isApproved).length;

    return { totalOrders, totalRevenue, shopEarnings, platformFees, activeOrders, pendingPayouts, disputedPayouts, totalPaidOut, activeShops: shops.filter(s => s.isOpen).length, pendingApprovals };
  }, [allOrders, payouts, shops]);

  // Filtered orders for search
  const filteredOrders = useMemo(() => {
    let result = allOrders;
    if (ordersShopFilter !== 'all') {
      result = result.filter(o => o.shopId === ordersShopFilter);
    }
    if (ordersSearch.trim()) {
      const search = ordersSearch.toLowerCase();
      result = result.filter(o =>
        o.fileName.toLowerCase().includes(search) ||
        o.id.toLowerCase().includes(search) ||
        o.userId.toLowerCase().includes(search) ||
        o.shopId.toLowerCase().includes(search) ||
        o.status.toLowerCase().includes(search)
      );
    }
    return result;
  }, [allOrders, ordersSearch, ordersShopFilter]);

  const filteredPayouts = useMemo(() => {
    if (payoutsShopFilter === 'all') return payouts;
    return payouts.filter(p => p.shopId === payoutsShopFilter);
  }, [payouts, payoutsShopFilter]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case OrderStatus.COMPLETED: return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400';
      case OrderStatus.CANCELLED: return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400';
      case OrderStatus.PENDING_PAYMENT: return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400';
      case OrderStatus.PENDING_APPROVAL: return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400';
      case OrderStatus.PRINTING: return 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400';
      case OrderStatus.READY_FOR_PICKUP: return 'bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400';
      case OrderStatus.PAYMENT_FAILED: return 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400';
      default: return 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400';
    }
  };

  const getPayoutStatusColor = (status: PayoutStatus) => {
    switch (status) {
      case PayoutStatus.PENDING: return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400';
      case PayoutStatus.PAID: return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400';
      case PayoutStatus.CONFIRMED: return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400';
      case PayoutStatus.DISPUTED: return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400';
      default: return 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400';
    }
  };

  const tabs: { key: AdminTab; label: string; icon: React.ReactNode }[] = [
    { key: 'overview', label: 'Overview', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M11.47 3.841a.75.75 0 0 1 1.06 0l8.69 8.69a.75.75 0 1 0 1.06-1.061l-8.689-8.69a2.25 2.25 0 0 0-3.182 0l-8.69 8.69a.75.75 0 1 0 1.061 1.06l8.69-8.689Z" /><path d="m12 5.432 8.159 8.159c.03.03.06.058.091.086v6.198c0 1.035-.84 1.875-1.875 1.875H15a.75.75 0 0 1-.75-.75v-4.5a.75.75 0 0 0-.75-.75h-3a.75.75 0 0 0-.75.75V21a.75.75 0 0 1-.75.75H5.625a1.875 1.875 0 0 1-1.875-1.875v-6.198a2.29 2.29 0 0 0 .091-.086L12 5.432Z" /></svg> },
    { key: 'shops', label: 'Shops', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M5.223 2.25h13.554a.75.75 0 0 1 .678.427l2.443 5.145a.75.75 0 0 1 .072.323v.5c0 1.59-.81 2.994-2.04 3.815v8.29a.75.75 0 0 1-.75.75H4.82a.75.75 0 0 1-.75-.75v-8.29a4.41 4.41 0 0 1-2.04-3.815v-.5a.75.75 0 0 1 .072-.323l2.443-5.145a.75.75 0 0 1 .678-.427Z" /></svg> },
    { key: 'payouts', label: 'Payouts', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M2.273 5.625A4.483 4.483 0 0 1 5.25 4.5h13.5c1.141 0 2.183.425 2.977 1.125A3 3 0 0 0 18.75 3H5.25a3 3 0 0 0-2.977 2.625ZM2.273 8.625A4.483 4.483 0 0 1 5.25 7.5h13.5c1.141 0 2.183.425 2.977 1.125A3 3 0 0 0 18.75 6H5.25a3 3 0 0 0-2.977 2.625ZM5.25 9a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h13.5a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3H15a.75.75 0 0 0-.75.75 2.25 2.25 0 0 1-4.5 0A.75.75 0 0 0 9 9H5.25Z" /></svg> },
    { key: 'orders', label: 'All Orders', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M7.502 6h7.128A3.375 3.375 0 0 1 18 9.375v9.375a3 3 0 0 0 3-3V6.108c0-1.505-1.125-2.811-2.664-2.94a48.972 48.972 0 0 0-.673-.05A3 3 0 0 0 15 1.5h-1.5a3 3 0 0 0-2.663 1.618c-.225.015-.45.032-.673.05C8.662 3.295 7.554 4.542 7.502 6ZM13.5 3A1.5 1.5 0 0 0 12 4.5h4.5A1.5 1.5 0 0 0 15 3h-1.5Z" clipRule="evenodd" /><path fillRule="evenodd" d="M3 9.375C3 8.339 3.84 7.5 4.875 7.5h9.75c1.036 0 1.875.84 1.875 1.875v11.25c0 1.035-.84 1.875-1.875 1.875h-9.75A1.875 1.875 0 0 1 3 20.625V9.375Zm9.586 4.594a.75.75 0 0 0-1.172-.938l-2.476 3.096-.908-.907a.75.75 0 0 0-1.06 1.06l1.5 1.5a.75.75 0 0 0 1.116-.062l3-3.75Z" clipRule="evenodd" /></svg> },
  ];

  return (
    <div ref={dashboardRef} className="space-y-6 pt-28">
      {/* Header */}
      <div className="admin-card">
        <div className="flex items-center gap-4 mb-2">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-lg shadow-purple-500/25">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7 text-white">
              <path fillRule="evenodd" d="M7.5 6a4.5 4.5 0 1 1 9 0 4.5 4.5 0 0 1-9 0ZM3.751 20.105a8.25 8.25 0 0 1 16.498 0 .75.75 0 0 1-.437.695A18.683 18.683 0 0 1 12 22.5c-2.786 0-5.433-.608-7.812-1.7a.75.75 0 0 1-.437-.695Z" clipRule="evenodd" />
            </svg>
          </div>
          <div>
            <h2 className="text-3xl font-bold text-gray-900 dark:text-white">Admin Dashboard</h2>
            <p className="text-gray-500 dark:text-gray-400 text-sm">Manage shops, orders, and payouts</p>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="admin-card flex gap-2 p-1.5 bg-gray-100 dark:bg-zinc-800 rounded-xl">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg text-sm font-medium transition-all duration-200 ${
              activeTab === tab.key
                ? 'bg-white dark:bg-zinc-700 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {tab.icon}
            <span className="hidden sm:inline">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Content based on active tab */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Stats Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="admin-card bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-xl p-5 border border-blue-200/50 dark:border-blue-800/30">
              <p className="text-xs font-semibold text-blue-600/70 dark:text-blue-400/70 uppercase tracking-wider">Total Revenue</p>
              <p className="text-3xl font-bold text-blue-700 dark:text-blue-300 mt-1">₹{stats.totalRevenue.toFixed(0)}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{stats.totalOrders} orders</p>
            </div>
            <div className="admin-card bg-gradient-to-br from-emerald-50 to-green-50 dark:from-emerald-900/20 dark:to-green-900/20 rounded-xl p-5 border border-emerald-200/50 dark:border-emerald-800/30">
              <p className="text-xs font-semibold text-emerald-600/70 dark:text-emerald-400/70 uppercase tracking-wider">Platform Fees</p>
              <p className="text-3xl font-bold text-emerald-700 dark:text-emerald-300 mt-1">₹{stats.platformFees.toFixed(0)}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Your earnings</p>
            </div>
            <div className="admin-card bg-gradient-to-br from-amber-50 to-yellow-50 dark:from-amber-900/20 dark:to-yellow-900/20 rounded-xl p-5 border border-amber-200/50 dark:border-amber-800/30">
              <p className="text-xs font-semibold text-amber-600/70 dark:text-amber-400/70 uppercase tracking-wider">Paid to Shops</p>
              <p className="text-3xl font-bold text-amber-700 dark:text-amber-300 mt-1">₹{stats.totalPaidOut.toFixed(0)}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Total settled</p>
            </div>
            <div className="admin-card bg-gradient-to-br from-purple-50 to-violet-50 dark:from-purple-900/20 dark:to-violet-900/20 rounded-xl p-5 border border-purple-200/50 dark:border-purple-800/30">
              <p className="text-xs font-semibold text-purple-600/70 dark:text-purple-400/70 uppercase tracking-wider">Active Shops</p>
              <p className="text-3xl font-bold text-purple-700 dark:text-purple-300 mt-1">{stats.activeShops}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">of {shops.length} total</p>
            </div>
            {stats.pendingApprovals > 0 && (
              <div className="admin-card bg-gradient-to-br from-orange-50 to-amber-50 dark:from-orange-900/20 dark:to-amber-900/20 rounded-xl p-5 border border-orange-200/50 dark:border-orange-800/30 col-span-2 md:col-span-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold text-orange-600/70 dark:text-orange-400/70 uppercase tracking-wider">Pending Shop Approvals</p>
                    <p className="text-3xl font-bold text-orange-700 dark:text-orange-300 mt-1">{stats.pendingApprovals}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Shops waiting for your approval</p>
                  </div>
                  <button onClick={() => setActiveTab('shops')} className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold rounded-lg transition-colors">
                    Review Now →
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Quick Info */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="admin-card bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700" noPadding>
              <div className="p-5">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-8 h-8 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-orange-600 dark:text-orange-400">
                      <path fillRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003Z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <h4 className="font-semibold text-gray-900 dark:text-white">Active Orders</h4>
                </div>
                <p className="text-4xl font-bold text-gray-900 dark:text-white">{stats.activeOrders}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Orders needing attention</p>
              </div>
            </Card>

            <Card className="admin-card bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700" noPadding>
              <div className="p-5">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-8 h-8 rounded-lg bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-rose-600 dark:text-rose-400">
                      <path fillRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003Z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <h4 className="font-semibold text-gray-900 dark:text-white">Disputed Payouts</h4>
                </div>
                <p className="text-4xl font-bold text-gray-900 dark:text-white">{stats.disputedPayouts}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{stats.disputedPayouts > 0 ? 'Need review' : 'All clear'}</p>
              </div>
            </Card>

            <Card className="admin-card bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700" noPadding>
              <div className="p-5">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-8 h-8 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-green-600 dark:text-green-400">
                      <path fillRule="evenodd" d="M7.5 6a4.5 4.5 0 1 1 9 0 4.5 4.5 0 0 1-9 0ZM3.751 20.105a8.25 8.25 0 0 1 16.498 0 .75.75 0 0 1-.437.695A18.683 18.683 0 0 1 12 22.5c-2.786 0-5.433-.608-7.812-1.7a.75.75 0 0 1-.437-.695Z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <h4 className="font-semibold text-gray-900 dark:text-white">Shop Earnings</h4>
                </div>
                <p className="text-4xl font-bold text-gray-900 dark:text-white">₹{stats.shopEarnings.toFixed(0)}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Total owed to shops</p>
              </div>
            </Card>
          </div>
        </div>
      )}

      {activeTab === 'shops' && (
        <div className="space-y-4">
          {shops.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {[...shops].sort((a, b) => Number(a.isApproved) - Number(b.isApproved)).map(shop => (
                <div key={shop.id} className="admin-card">
                  <AdminShopCard
                    shop={shop}
                    orders={allOrders}
                    payouts={payouts}
                    onCreatePayout={setSelectedShopForPayout}
                  />
                </div>
              ))}
            </div>
          ) : (
            <Card className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-center py-12">
              <p className="text-gray-500 dark:text-gray-400">No shops registered yet.</p>
            </Card>
          )}
        </div>
      )}

      {activeTab === 'payouts' && (
        <div className="space-y-4">
          <div className="flex justify-start mb-4">
            <select
              value={payoutsShopFilter}
              onChange={(e) => setPayoutsShopFilter(e.target.value)}
              className="px-4 py-2 rounded-lg bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-primary"
            >
              <option value="all">All Shops</option>
              {shops.map(shop => (
                <option key={shop.id} value={shop.id}>{shop.name}</option>
              ))}
            </select>
          </div>
          {filteredPayouts.length > 0 ? (
            <div className="admin-card bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-700 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-zinc-800 border-b border-gray-200 dark:border-zinc-700">
                      <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Shop</th>
                      <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Amount</th>
                      <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Status</th>
                      <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Note</th>
                      <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-zinc-800">
                    {filteredPayouts.map(payout => (
                      <tr key={payout.id} className="hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors">
                        <td className="p-4 font-medium text-gray-900 dark:text-white">{payout.shopName}</td>
                        <td className="p-4 font-bold text-gray-900 dark:text-white">₹{payout.amount.toFixed(2)}</td>
                        <td className="p-4">
                          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${getPayoutStatusColor(payout.status)}`}>
                            {payout.status}
                          </span>
                        </td>
                        <td className="p-4 text-gray-500 dark:text-gray-400 max-w-[200px] truncate">
                          {payout.adminNote || '—'}
                          {payout.shopOwnerNote && <span className="block text-xs text-red-500 mt-1">Shop: {payout.shopOwnerNote}</span>}
                        </td>
                        <td className="p-4 text-gray-500 dark:text-gray-400 text-xs">{new Date(payout.createdAt).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <Card className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-center py-12">
              <p className="text-gray-500 dark:text-gray-400">No payouts yet. Go to Shops tab to send your first payout.</p>
            </Card>
          )}
        </div>
      )}

      {activeTab === 'orders' && (
        <div className="space-y-4">
          {/* Controls */}
          <div className="flex flex-col sm:flex-row gap-4 mb-4">
            <select
              value={ordersShopFilter}
              onChange={(e) => setOrdersShopFilter(e.target.value)}
              className="px-4 py-2 rounded-lg bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-primary sm:w-1/4"
            >
              <option value="all">All Shops</option>
              {shops.map(shop => (
                <option key={shop.id} value={shop.id}>{shop.name}</option>
              ))}
            </select>
            <div className="relative flex-1">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                <path fillRule="evenodd" d="M10.5 3.75a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5ZM2.25 10.5a8.25 8.25 0 1 1 14.59 5.28l4.69 4.69a.75.75 0 1 1-1.06 1.06l-4.69-4.69A8.25 8.25 0 0 1 2.25 10.5Z" clipRule="evenodd" />
              </svg>
              <input
                type="text"
                placeholder="Search orders by filename, ID, user, shop, or status..."
                value={ordersSearch}
                onChange={(e) => setOrdersSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-3 rounded-xl bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:border-transparent transition-all"
              />
            </div>
          </div>

          {/* Orders Table */}
          {filteredOrders.length > 0 ? (
            <div className="admin-card bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-700 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-zinc-800 border-b border-gray-200 dark:border-zinc-700">
                      <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Order</th>
                      <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">File</th>
                      <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Shop</th>
                      <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Amount</th>
                      <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Status</th>
                      <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-zinc-800">
                    {filteredOrders.slice(0, ordersLimit).map(order => {
                      const shop = shops.find(s => s.id === order.shopId);
                      return (
                        <tr key={order.id} className="hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors">
                          <td className="p-4 font-mono text-xs text-gray-500 dark:text-gray-400">#{order.id.slice(-6)}</td>
                          <td className="p-4 font-medium text-gray-900 dark:text-white max-w-[180px] truncate">{order.fileName}</td>
                          <td className="p-4 text-gray-600 dark:text-gray-300">{shop?.name || order.shopId.slice(-6)}</td>
                          <td className="p-4 font-bold text-gray-900 dark:text-white">₹{order.priceDetails.totalPrice.toFixed(2)}</td>
                          <td className="p-4">
                            <span className={`px-2.5 py-1 rounded-full text-xs font-semibold capitalize ${getStatusColor(order.status)}`}>
                              {order.status.replace(/_/g, ' ').toLowerCase()}
                            </span>
                          </td>
                          <td className="p-4 text-gray-500 dark:text-gray-400 text-xs">{new Date(order.uploadedAt).toLocaleDateString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {(filteredOrders.length > ordersLimit || ordersLimit > 50) && (
                <div className="p-4 flex justify-center gap-3 border-t border-gray-200 dark:border-zinc-700">
                  {filteredOrders.length > ordersLimit && (
                    <button
                      onClick={() => setOrdersLimit(prev => prev + 50)}
                      className="px-5 py-2 text-sm font-medium text-brand-primary bg-brand-primary/10 hover:bg-brand-primary/20 rounded-lg transition-colors"
                    >
                      Load More ({filteredOrders.length - ordersLimit} remaining)
                    </button>
                  )}
                  {ordersLimit > 50 && (
                    <button
                      onClick={() => setOrdersLimit(50)}
                      className="px-5 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg transition-colors"
                    >
                      Show Less
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <Card className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-center py-12">
              <p className="text-gray-500 dark:text-gray-400">
                {ordersSearch ? 'No orders match your search.' : 'No orders yet.'}
              </p>
            </Card>
          )}
        </div>
      )}

      {/* Payout Modal */}
      {selectedShopForPayout && (
        <AdminPayoutModal
          isOpen={!!selectedShopForPayout}
          onClose={() => setSelectedShopForPayout(null)}
          shop={selectedShopForPayout}
          allOrders={allOrders}
          payouts={payouts}
        />
      )}
    </div>
  );
};

export default AdminDashboard;
