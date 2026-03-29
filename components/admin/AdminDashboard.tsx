import React, { useState, useMemo, useRef } from 'react';
import { useAppContext } from '../../contexts/AppContext';
import { ShopProfile, OrderStatus, PayoutStatus, DocumentOrder } from '../../types';
import AdminShopCard from './AdminShopCard';
import AdminPayoutModal from './AdminPayoutModal';
import { Card } from '../common/Card';
import { RefundOtpModal } from '../common/RefundOtpModal';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import TicketList from '../tickets/TicketList';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '../../firebase';
import { Button } from '../common/Button';

type AdminTab = 'overview' | 'shops' | 'payouts' | 'orders' | 'tickets';

const AdminDashboard: React.FC = () => {
  const { shops, allOrders, payouts, studentPassHolders, tickets, reports } = useAppContext();
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const [selectedShopForPayout, setSelectedShopForPayout] = useState<ShopProfile | null>(null);
  const [ordersSearch, setOrdersSearch] = useState('');
  const [selectedOrdersShop, setSelectedOrdersShop] = useState<string | null>(null);
  const [payoutsShopFilter, setPayoutsShopFilter] = useState<string>('all');
  const [ordersLimit, setOrdersLimit] = useState(50);
  const dashboardRef = useRef<HTMLDivElement>(null);

  // Expandable order detail & refund
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [refundModalOrder, setRefundModalOrder] = useState<DocumentOrder | null>(null);
  const [refundReason, setRefundReason] = useState('');
  const [isIssuingRefund, setIsIssuingRefund] = useState(false);
  const [refundResult, setRefundResult] = useState<{ success: boolean; message: string } | null>(null);

  // OTP State
  const [isRequestingOTP, setIsRequestingOTP] = useState(false);
  const [otpSent, setOtpSent] = useState(false);

  // Report generation state
  const [reportStartDate, setReportStartDate] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().split('T')[0];
  });
  const [reportEndDate, setReportEndDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [reportError, setReportError] = useState('');

  useGSAP(() => {
    gsap.from(".admin-card", {
      y: 20,
      opacity: 0,
      duration: 0.6,
      stagger: 0.08,
      ease: "power3.out",
    });
  }, { scope: dashboardRef, dependencies: [activeTab, shops.length] });

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

    // Subscription revenue
    const totalPassHolders = studentPassHolders.length;
    const subscriptionRevenue = totalPassHolders * 49; // ₹49 per pass

    return { totalOrders, totalRevenue, shopEarnings, platformFees, activeOrders, pendingPayouts, disputedPayouts, totalPaidOut, activeShops: shops.filter(s => s.isOpen).length, pendingApprovals, totalPassHolders, subscriptionRevenue };
  }, [allOrders, payouts, shops, studentPassHolders]);

  // Filtered orders for search
  const filteredOrders = useMemo(() => {
    let result = allOrders;
    if (ordersSearch.trim()) {
      const search = ordersSearch.toLowerCase();
      result = result.filter(o =>
        o.fileName.toLowerCase().includes(search) ||
        o.id.toLowerCase().includes(search) ||
        o.userId.toLowerCase().includes(search) ||
        (o.userName || '').toLowerCase().includes(search) ||
        o.status.toLowerCase().includes(search)
      );
    }
    return result;
  }, [allOrders, ordersSearch]);

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

  // Helper: derive payment tracking status for display
  const getPaymentTrackingStatus = (order: DocumentOrder): { label: string; icon: string; color: string } => {
    if (order.refundId && order.refundStatus !== 'FAILED') {
      return {
        label: order.refundStatus === 'processed' ? 'Refunded' : 'Refund Pending',
        icon: '🔄',
        color: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400',
      };
    }
    if (order.refundStatus === 'FAILED') {
      return {
        label: 'Refund Failed',
        icon: '⚠️',
        color: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
      };
    }
    if (order.status === OrderStatus.CANCELLED && order.razorpayPaymentId && !order.refundId) {
      return {
        label: 'Needs Refund',
        icon: '⚠️',
        color: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400',
      };
    }
    if (order.razorpayPaymentId) {
      return {
        label: 'Captured',
        icon: '✅',
        color: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400',
      };
    }
    if (order.status === OrderStatus.PAYMENT_FAILED) {
      return {
        label: 'Failed',
        icon: '❌',
        color: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
      };
    }
    if (order.status === OrderStatus.PENDING_PAYMENT) {
      return {
        label: 'Awaiting',
        icon: '⏳',
        color: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
      };
    }
    return {
      label: 'N/A',
      icon: '—',
      color: 'bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-gray-400',
    };
  };

  // Handle requesting the OTP
  const handleRequestOTP = async () => {
    if (!refundModalOrder) return;
    setIsRequestingOTP(true);
    setRefundResult(null);
    try {
      const functions = getFunctions(app, 'asia-south1');
      const requestRefundOTPFn = httpsCallable(functions, 'requestRefundOTP');
      await requestRefundOTPFn({ orderId: refundModalOrder.id });
      setOtpSent(true);
      setRefundResult({ success: true, message: 'OTP sent! Please check your admin mailbox.' });
    } catch (err: any) {
      setRefundResult({ success: false, message: err.message || 'Failed to send OTP.' });
    }
    setIsRequestingOTP(false);
  };

  // Handle confirming refund with OTP
  const handleConfirmRefund = async (enteredOtp: string) => {
    if (!refundModalOrder || !enteredOtp.trim()) return;
    setIsIssuingRefund(true);
    setRefundResult(null);
    try {
      const functions = getFunctions(app, 'asia-south1');
      const initiateRefundFn = httpsCallable(functions, 'initiateRefund');
      const result = await initiateRefundFn({
        orderId: refundModalOrder.id,
        reason: refundReason.trim() || 'Admin-initiated refund',
        otp: enteredOtp.trim(),
      });
      const data = result.data as { success: boolean; message: string };
      setRefundResult({ success: true, message: data.message || 'Refund initiated successfully.' });
      setOtpSent(false); // Reset
    } catch (err: any) {
      setRefundResult({ success: false, message: err.message || 'Refund failed. Invalid OTP?' });
    }
    setIsIssuingRefund(false);
  };

  const tabs: { key: AdminTab; label: string; icon: React.ReactNode }[] = [
    { key: 'overview', label: 'Overview', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M11.47 3.841a.75.75 0 0 1 1.06 0l8.69 8.69a.75.75 0 1 0 1.06-1.061l-8.689-8.69a2.25 2.25 0 0 0-3.182 0l-8.69 8.69a.75.75 0 1 0 1.061 1.06l8.69-8.689Z" /><path d="m12 5.432 8.159 8.159c.03.03.06.058.091.086v6.198c0 1.035-.84 1.875-1.875 1.875H15a.75.75 0 0 1-.75-.75v-4.5a.75.75 0 0 0-.75-.75h-3a.75.75 0 0 0-.75.75V21a.75.75 0 0 1-.75.75H5.625a1.875 1.875 0 0 1-1.875-1.875v-6.198a2.29 2.29 0 0 0 .091-.086L12 5.432Z" /></svg> },
    { key: 'shops', label: 'Shops', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M5.223 2.25h13.554a.75.75 0 0 1 .678.427l2.443 5.145a.75.75 0 0 1 .072.323v.5c0 1.59-.81 2.994-2.04 3.815v8.29a.75.75 0 0 1-.75.75H4.82a.75.75 0 0 1-.75-.75v-8.29a4.41 4.41 0 0 1-2.04-3.815v-.5a.75.75 0 0 1 .072-.323l2.443-5.145a.75.75 0 0 1 .678-.427Z" /></svg> },
    { key: 'payouts', label: 'Payouts', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M2.273 5.625A4.483 4.483 0 0 1 5.25 4.5h13.5c1.141 0 2.183.425 2.977 1.125A3 3 0 0 0 18.75 3H5.25a3 3 0 0 0-2.977 2.625ZM2.273 8.625A4.483 4.483 0 0 1 5.25 7.5h13.5c1.141 0 2.183.425 2.977 1.125A3 3 0 0 0 18.75 6H5.25a3 3 0 0 0-2.977 2.625ZM5.25 9a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h13.5a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3H15a.75.75 0 0 0-.75.75 2.25 2.25 0 0 1-4.5 0A.75.75 0 0 0 9 9H5.25Z" /></svg> },
    { key: 'orders', label: 'All Orders', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M7.502 6h7.128A3.375 3.375 0 0 1 18 9.375v9.375a3 3 0 0 0 3-3V6.108c0-1.505-1.125-2.811-2.664-2.94a48.972 48.972 0 0 0-.673-.05A3 3 0 0 0 15 1.5h-1.5a3 3 0 0 0-2.663 1.618c-.225.015-.45.032-.673.05C8.662 3.295 7.554 4.542 7.502 6ZM13.5 3A1.5 1.5 0 0 0 12 4.5h4.5A1.5 1.5 0 0 0 15 3h-1.5Z" clipRule="evenodd" /><path fillRule="evenodd" d="M3 9.375C3 8.339 3.84 7.5 4.875 7.5h9.75c1.036 0 1.875.84 1.875 1.875v11.25c0 1.035-.84 1.875-1.875 1.875h-9.75A1.875 1.875 0 0 1 3 20.625V9.375Zm9.586 4.594a.75.75 0 0 0-1.172-.938l-2.476 3.096-.908-.907a.75.75 0 0 0-1.06 1.06l1.5 1.5a.75.75 0 0 0 1.116-.062l3-3.75Z" clipRule="evenodd" /></svg> },
    { key: 'tickets', label: 'Tickets', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0 1 12 2.25c2.43 0 4.817.178 7.152.52a1.834 1.834 0 0 1 1.529 1.657l.293 3.513a1.834 1.834 0 0 1-1.307 1.92l-.416.14a3.118 3.118 0 0 0-1.898 4.084l.108.27a1.835 1.835 0 0 1-.9 2.267l-3.19 1.595a1.835 1.835 0 0 1-2.118-.355L9.69 16.3a3.118 3.118 0 0 0-4.253-.143l-.295.268a1.834 1.834 0 0 1-2.445-.198l-1.06-1.162a1.834 1.834 0 0 1-.286-2.066l.168-.336a3.118 3.118 0 0 0-1.034-3.82l-.35-.247A1.834 1.834 0 0 1 .26 6.62l.592-3.209a1.835 1.835 0 0 1 1.532-1.494l2.464-.146Z" clipRule="evenodd" /></svg> },
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
            <div className="admin-card bg-gradient-to-br from-rose-50 to-pink-50 dark:from-rose-900/20 dark:to-pink-900/20 rounded-xl p-5 border border-rose-200/50 dark:border-rose-800/30">
              <p className="text-xs font-semibold text-rose-600/70 dark:text-rose-400/70 uppercase tracking-wider">Student Pass Revenue</p>
              <p className="text-3xl font-bold text-rose-700 dark:text-rose-300 mt-1">₹{stats.subscriptionRevenue}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{stats.totalPassHolders} subscribers × ₹49</p>
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

          {/* Student Pass Subscribers */}
          {studentPassHolders.length > 0 && (
            <Card className="admin-card bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700" noPadding>
              <div className="p-5 border-b border-gray-200 dark:border-zinc-700">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-rose-600 dark:text-rose-400">
                        <path fillRule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <h4 className="font-semibold text-gray-900 dark:text-white">Student Pass Subscribers</h4>
                  </div>
                  <span className="text-sm font-bold text-rose-600 dark:text-rose-400">₹{stats.subscriptionRevenue} total</span>
                </div>
              </div>
              <div className="divide-y divide-gray-100 dark:divide-zinc-800 max-h-64 overflow-y-auto">
                {[...studentPassHolders]
                  .sort((a, b) => new Date(b.studentPassActivatedAt || 0).getTime() - new Date(a.studentPassActivatedAt || 0).getTime())
                  .map((holder) => (
                  <div key={holder.id} className="px-5 py-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{holder.name || 'Unknown'}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{holder.email || holder.id.slice(-8)}</p>
                    </div>
                    <div className="text-right">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-gradient-to-r from-amber-400 to-yellow-500 text-amber-900">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                          <path fillRule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z" clipRule="evenodd" />
                        </svg>
                        ₹49
                      </span>
                      {holder.studentPassActivatedAt && (
                        <p className="text-[10px] text-gray-400 mt-0.5">{new Date(holder.studentPassActivatedAt).toLocaleDateString()}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Earnings Reports */}
          <Card className="admin-card bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700" noPadding>
            <div className="p-5 border-b border-gray-200 dark:border-zinc-700">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4 text-indigo-600 dark:text-indigo-400">
                    <path fillRule="evenodd" d="M5.625 1.5H9a3.75 3.75 0 0 1 3.75 3.75v1.875c0 1.036.84 1.875 1.875 1.875H16.5a3.75 3.75 0 0 1 3.75 3.75v7.875c0 1.035-.84 1.875-1.875 1.875H5.625a1.875 1.875 0 0 1-1.875-1.875V3.375c0-1.036.84-1.875 1.875-1.875ZM12.75 12a.75.75 0 0 0-1.5 0v2.25H9a.75.75 0 0 0 0 1.5h2.25V18a.75.75 0 0 0 1.5 0v-2.25H15a.75.75 0 0 0 0-1.5h-2.25V12Z" clipRule="evenodd" />
                  </svg>
                </div>
                <h4 className="font-semibold text-gray-900 dark:text-white">Earnings Reports</h4>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">From</label>
                  <input
                    type="date"
                    value={reportStartDate}
                    onChange={(e) => setReportStartDate(e.target.value)}
                    className="px-3 py-2 rounded-lg bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 text-sm text-gray-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">To</label>
                  <input
                    type="date"
                    value={reportEndDate}
                    onChange={(e) => setReportEndDate(e.target.value)}
                    className="px-3 py-2 rounded-lg bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 text-sm text-gray-900 dark:text-white"
                  />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={isGeneratingReport}
                  onClick={async () => {
                    setIsGeneratingReport(true);
                    setReportError('');
                    try {
                      const functions = getFunctions(undefined, 'asia-south1');
                      const generateReport = httpsCallable(functions, 'generateEarningsReport');
                      const result = await generateReport({
                        startDate: new Date(reportStartDate).toISOString(),
                        endDate: new Date(reportEndDate + 'T23:59:59').toISOString(),
                        reportType: 'full',
                      });
                      const data = result.data as { downloadUrl?: string };
                      if (data.downloadUrl) {
                        window.open(data.downloadUrl, '_blank');
                      }
                    } catch (err: any) {
                      setReportError(err.message || 'Failed to generate report.');
                    }
                    setIsGeneratingReport(false);
                  }}
                  className="!bg-gradient-to-r !from-indigo-500 !to-purple-600"
                >
                  {isGeneratingReport ? 'Generating...' : '📊 Generate Excel Report'}
                </Button>
              </div>
              {reportError && <p className="text-xs text-red-500 mt-2">{reportError}</p>}
            </div>
            {/* Past reports list */}
            {reports.length > 0 && (
              <div className="divide-y divide-gray-100 dark:divide-zinc-800 max-h-48 overflow-y-auto">
                {reports.map(report => (
                  <div key={report.id} className="px-5 py-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-white">
                        {new Date(report.startDate).toLocaleDateString()} – {new Date(report.endDate).toLocaleDateString()}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {report.totalOrders} orders • ₹{report.totalRevenue?.toFixed(2)} revenue
                      </p>
                    </div>
                    {report.downloadUrl && (
                      <a
                        href={report.downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-brand-primary hover:underline"
                      >
                        Download ↓
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
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
          {!selectedOrdersShop ? (
            /* Level 1: Shop list */
            <>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Select a shop to view orders</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {shops.map(shop => {
                  const shopOrderCount = allOrders.filter(o => o.shopId === shop.id).length;
                  const activeCount = allOrders.filter(o => o.shopId === shop.id && o.status !== OrderStatus.COMPLETED && o.status !== OrderStatus.CANCELLED && o.status !== OrderStatus.PAYMENT_FAILED && o.status !== OrderStatus.PENDING_PAYMENT).length;
                  return (
                    <button
                      key={shop.id}
                      onClick={() => setSelectedOrdersShop(shop.id)}
                      className="text-left bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-700 p-5 hover:border-brand-primary/50 hover:shadow-lg transition-all duration-200 group animate-fade-in"
                    >
                      <div className="flex items-center gap-3 mb-3">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shadow-sm ${shop.isOpen ? 'bg-gradient-to-br from-indigo-500 to-purple-600' : 'bg-gradient-to-br from-gray-400 to-gray-500'}`}>
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white">
                            <path d="M5.223 2.25h13.554a.75.75 0 0 1 .678.427l2.443 5.145a.75.75 0 0 1 .072.323v.5c0 1.59-.81 2.994-2.04 3.815v8.29a.75.75 0 0 1-.75.75H4.82a.75.75 0 0 1-.75-.75v-8.29a4.41 4.41 0 0 1-2.04-3.815v-.5a.75.75 0 0 1 .072-.323l2.443-5.145a.75.75 0 0 1 .678-.427Z" />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-bold text-gray-900 dark:text-white truncate group-hover:text-brand-primary transition-colors">{shop.name}</h4>
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{shop.address}</p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${shop.isOpen ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'}`}>
                            {shop.isOpen ? 'Open' : 'Closed'}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex gap-3">
                          <span className="text-xs text-gray-500 dark:text-gray-400">{shopOrderCount} orders</span>
                          {activeCount > 0 && (
                            <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">{activeCount} active</span>
                          )}
                        </div>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-gray-400 group-hover:text-brand-primary transition-colors">
                          <path fillRule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.638L10.23 5.29a.75.75 0 1 1 1.04-1.08l5.5 5.25a.75.75 0 0 1 0 1.08l-5.5 5.25a.75.75 0 1 1-1.04-1.08l4.158-3.96H3.75A.75.75 0 0 1 3 10Z" clipRule="evenodd" />
                        </svg>
                      </div>
                    </button>
                  );
                })}
              </div>
              {shops.length === 0 && (
                <Card className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-center py-12">
                  <p className="text-gray-500 dark:text-gray-400">No shops registered yet.</p>
                </Card>
              )}
            </>
          ) : (
            /* Level 2: Orders for selected shop */
            <>
              <div className="flex items-center gap-3 mb-2">
                <button
                  onClick={() => setSelectedOrdersShop(null)}
                  className="flex items-center gap-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-brand-primary transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clipRule="evenodd" />
                  </svg>
                  Back to shops
                </button>
                <span className="text-gray-300 dark:text-zinc-600">|</span>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  {shops.find(s => s.id === selectedOrdersShop)?.name || 'Shop'} — Orders
                </h3>
              </div>

              {/* Search within shop orders */}
              <div className="relative">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                  <path fillRule="evenodd" d="M10.5 3.75a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5ZM2.25 10.5a8.25 8.25 0 1 1 14.59 5.28l4.69 4.69a.75.75 0 1 1-1.06 1.06l-4.69-4.69A8.25 8.25 0 0 1 2.25 10.5Z" clipRule="evenodd" />
                </svg>
                <input
                  type="text"
                  placeholder="Search orders by filename, ID, user, or status..."
                  value={ordersSearch}
                  onChange={(e) => setOrdersSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:border-transparent transition-all"
                />
              </div>

              {/* Orders Table */}
              {filteredOrders.filter(o => o.shopId === selectedOrdersShop).length > 0 ? (
                <div className="admin-card bg-white dark:bg-zinc-900 rounded-xl border border-gray-200 dark:border-zinc-700 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 dark:bg-zinc-800 border-b border-gray-200 dark:border-zinc-700">
                          <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400 w-8"></th>
                          <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Order</th>
                          <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">File</th>
                          <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Student</th>
                          <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Amount</th>
                          <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Status</th>
                          <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Payment</th>
                          <th className="text-left p-4 font-semibold text-gray-600 dark:text-gray-400">Date</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-zinc-800">
                        {filteredOrders.filter(o => o.shopId === selectedOrdersShop).slice(0, ordersLimit).map(order => {
                          const isExpanded = expandedOrderId === order.id;
                          const paymentStatus = getPaymentTrackingStatus(order);
                          return (
                            <React.Fragment key={order.id}>
                              <tr
                                onClick={() => setExpandedOrderId(isExpanded ? null : order.id)}
                                className={`hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer ${isExpanded ? 'bg-gray-50 dark:bg-zinc-800/30' : ''}`}
                              >
                                <td className="pl-4 pr-1 py-4">
                                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>
                                    <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
                                  </svg>
                                </td>
                                <td className="p-4 font-mono text-xs text-gray-500 dark:text-gray-400">#{order.id.slice(-6)}</td>
                                <td className="p-4 font-medium text-gray-900 dark:text-white max-w-[180px] truncate">
                                  {order.fileName}
                                  {order.specialInstructions && <span className="ml-1 text-amber-500" title="Has special instructions">📝</span>}
                                </td>
                                <td className="p-4 text-gray-600 dark:text-gray-300">{order.userName || order.userId.slice(-6)}</td>
                                <td className="p-4 font-bold text-gray-900 dark:text-white">₹{order.priceDetails.totalPrice.toFixed(2)}</td>
                                <td className="p-4">
                                  <span className={`px-2.5 py-1 rounded-full text-xs font-semibold capitalize ${getStatusColor(order.status)}`}>
                                    {order.status.replace(/_/g, ' ').toLowerCase()}
                                  </span>
                                </td>
                                <td className="p-4">
                                  <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${paymentStatus.color}`}>
                                    {paymentStatus.icon} {paymentStatus.label}
                                  </span>
                                </td>
                                <td className="p-4 text-gray-500 dark:text-gray-400 text-xs">{new Date(order.uploadedAt).toLocaleDateString()}</td>
                              </tr>

                              {/* Expanded Payment Detail Row */}
                              {isExpanded && (
                                <tr>
                                  <td colSpan={8} className="p-0">
                                    <div className="bg-gray-50 dark:bg-zinc-800/50 border-t border-b border-gray-200 dark:border-zinc-700 px-6 py-4">
                                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                        {/* Payment Timeline */}
                                        <div className="space-y-3">
                                          <h6 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Payment Timeline</h6>
                                          <div className="space-y-2 pl-3 border-l-2 border-gray-300 dark:border-zinc-600">
                                            <div className="relative">
                                              <div className="absolute -left-[17px] top-0.5 w-2 h-2 rounded-full bg-blue-500"></div>
                                              <p className="text-xs text-gray-600 dark:text-gray-300 font-medium">Order Created</p>
                                              <p className="text-[10px] text-gray-400">{new Date(order.uploadedAt).toLocaleString()}</p>
                                            </div>
                                            {order.paymentAttemptedAt && (
                                              <div className="relative">
                                                <div className={`absolute -left-[17px] top-0.5 w-2 h-2 rounded-full ${order.razorpayPaymentId ? 'bg-emerald-500' : 'bg-red-500'}`}></div>
                                                <p className="text-xs text-gray-600 dark:text-gray-300 font-medium">
                                                  {order.razorpayPaymentId ? 'Payment Captured ✅' : 'Payment Attempted'}
                                                </p>
                                                <p className="text-[10px] text-gray-400">{new Date(order.paymentAttemptedAt).toLocaleString()}</p>
                                              </div>
                                            )}
                                            {order.status === OrderStatus.PAYMENT_FAILED && (
                                              <div className="relative">
                                                <div className="absolute -left-[17px] top-0.5 w-2 h-2 rounded-full bg-red-500"></div>
                                                <p className="text-xs text-red-600 dark:text-red-400 font-medium">Payment Failed ❌</p>
                                              </div>
                                            )}
                                            {order.refundedAt && (
                                              <div className="relative">
                                                <div className={`absolute -left-[17px] top-0.5 w-2 h-2 rounded-full ${order.refundStatus === 'FAILED' ? 'bg-red-500' : 'bg-purple-500'}`}></div>
                                                <p className={`text-xs font-medium ${order.refundStatus === 'FAILED' ? 'text-red-600 dark:text-red-400' : 'text-purple-600 dark:text-purple-400'}`}>
                                                  {order.refundStatus === 'FAILED' ? 'Refund Failed ⚠️' : `Refund ${order.refundStatus === 'processed' ? 'Processed' : 'Initiated'} 🔄`}
                                                </p>
                                                <p className="text-[10px] text-gray-400">{new Date(order.refundedAt).toLocaleString()}</p>
                                              </div>
                                            )}
                                          </div>
                                        </div>

                                        {/* Payment IDs */}
                                        <div className="space-y-3">
                                          <h6 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Payment Details</h6>
                                          <div className="space-y-2">
                                            <div>
                                              <p className="text-[10px] text-gray-400 dark:text-gray-500">Razorpay Order ID</p>
                                              <p className="text-xs font-mono text-gray-700 dark:text-gray-300 break-all">
                                                {order.razorpayOrderId || <span className="text-gray-400 italic">Not created</span>}
                                              </p>
                                            </div>
                                            <div>
                                              <p className="text-[10px] text-gray-400 dark:text-gray-500">Payment ID</p>
                                              <p className="text-xs font-mono text-gray-700 dark:text-gray-300 break-all">
                                                {order.razorpayPaymentId || <span className="text-gray-400 italic">No payment captured</span>}
                                              </p>
                                            </div>
                                            {order.paymentVerifiedVia && (
                                              <div>
                                                <p className="text-[10px] text-gray-400 dark:text-gray-500">Verified Via</p>
                                                <p className="text-xs text-gray-700 dark:text-gray-300 capitalize">
                                                  {order.paymentVerifiedVia.replace(/_/g, ' ')}
                                                </p>
                                              </div>
                                            )}
                                          </div>
                                        </div>

                                        {/* Refund Details + Actions */}
                                        <div className="space-y-3">
                                          <h6 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Refund</h6>
                                          {order.refundId ? (
                                            <div className="space-y-2">
                                              <div>
                                                <p className="text-[10px] text-gray-400 dark:text-gray-500">Refund ID</p>
                                                <p className="text-xs font-mono text-gray-700 dark:text-gray-300 break-all">{order.refundId}</p>
                                              </div>
                                              <div>
                                                <p className="text-[10px] text-gray-400 dark:text-gray-500">Status</p>
                                                <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                                  order.refundStatus === 'FAILED'
                                                    ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                                                    : order.refundStatus === 'processed'
                                                      ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                                                      : 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                                                }`}>
                                                  {order.refundStatus === 'FAILED' ? '❌ Failed' :
                                                   order.refundStatus === 'processed' ? '✅ Processed' : '⏳ Pending'}
                                                </span>
                                              </div>
                                              {order.refundAmount != null && (
                                                <div>
                                                  <p className="text-[10px] text-gray-400 dark:text-gray-500">Amount</p>
                                                  <p className="text-sm font-bold text-gray-900 dark:text-white">₹{order.refundAmount.toFixed(2)}</p>
                                                </div>
                                              )}
                                              {order.refundError && (
                                                <p className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 px-2 py-1 rounded">Error: {order.refundError}</p>
                                              )}
                                              {/* Retry refund if it failed */}
                                              {order.refundStatus === 'FAILED' && order.razorpayPaymentId && (
                                                <Button
                                                  size="sm"
                                                  variant="primary"
                                                  onClick={(e) => { e.stopPropagation(); setRefundModalOrder(order); setRefundReason('Retry: ' + (order.refundError || '')); }}
                                                  className="!bg-gradient-to-r !from-red-500 !to-orange-600 mt-1"
                                                >
                                                  🔄 Retry Refund
                                                </Button>
                                              )}
                                            </div>
                                          ) : order.razorpayPaymentId ? (
                                            <div className="space-y-2">
                                              <p className="text-xs text-gray-500 dark:text-gray-400">No refund issued yet.</p>
                                              <Button
                                                size="sm"
                                                variant="primary"
                                                onClick={(e) => { e.stopPropagation(); setRefundModalOrder(order); setRefundReason(''); }}
                                                className="!bg-gradient-to-r !from-violet-500 !to-purple-600"
                                              >
                                                💸 Issue Refund
                                              </Button>
                                            </div>
                                          ) : (
                                            <p className="text-xs text-gray-400 italic">No payment to refund</p>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {filteredOrders.filter(o => o.shopId === selectedOrdersShop).length > ordersLimit && (
                    <div className="p-4 flex justify-center border-t border-gray-200 dark:border-zinc-700">
                      <button
                        onClick={() => setOrdersLimit(prev => prev + 50)}
                        className="px-5 py-2 text-sm font-medium text-brand-primary bg-brand-primary/10 hover:bg-brand-primary/20 rounded-lg transition-colors"
                      >
                        Load More
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <Card className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-center py-12">
                  <p className="text-gray-500 dark:text-gray-400">
                    {ordersSearch ? 'No orders match your search.' : 'No orders for this shop yet.'}
                  </p>
                </Card>
              )}
            </>
          )}
        </div>
      )}

      {/* ===== TICKETS TAB ===== */}
      {activeTab === 'tickets' && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Support Tickets ({tickets.length})</h3>
          <TicketList tickets={tickets} showRaiserInfo />
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

      {/* Issue Refund Confirmation Modal */}
      {refundModalOrder && (
        <RefundOtpModal
          isOpen={!!refundModalOrder}
          onClose={() => { setRefundModalOrder(null); setRefundResult(null); setRefundReason(''); setOtpSent(false); }}
          orderId={refundModalOrder.id}
          onConfirm={handleConfirmRefund}
          onRequestOTP={handleRequestOTP}
          isIssuingRefund={isIssuingRefund}
          isRequestingOTP={isRequestingOTP}
          otpSent={otpSent}
          resultMessage={refundResult}
        >
          <div className="bg-gray-50 dark:bg-zinc-800 rounded-xl p-4 border border-gray-200 dark:border-zinc-700 mb-4">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">Order</span>
              <span className="text-sm font-mono text-gray-900 dark:text-white">#{refundModalOrder.id.slice(-6)}</span>
            </div>
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">Student</span>
              <span className="text-sm text-gray-900 dark:text-white">{refundModalOrder.userName || refundModalOrder.userId.slice(-6)}</span>
            </div>
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">Payment ID</span>
              <span className="text-xs font-mono text-gray-700 dark:text-gray-300">{refundModalOrder.razorpayPaymentId}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-500 dark:text-gray-400">Refund Amount</span>
              <span className="text-lg font-bold text-gray-900 dark:text-white">₹{refundModalOrder.priceDetails.totalPrice.toFixed(2)}</span>
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Reason (optional)</label>
            <textarea
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
              placeholder="e.g. Print quality issue, wrong document printed..."
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-primary text-sm resize-none"
            />
          </div>

          <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800 mb-2">
            <p className="text-xs text-amber-700 dark:text-amber-300">
              ⚠️ This will issue a full refund of <strong>₹{refundModalOrder.priceDetails.totalPrice.toFixed(2)}</strong> to the student's original payment method. The refund typically takes 5-7 business days.
            </p>
          </div>
        </RefundOtpModal>
      )}
    </div>
  );
};

export default AdminDashboard;
