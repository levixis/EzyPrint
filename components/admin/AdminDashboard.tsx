import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useAppContext } from '../../contexts/AppContext';
import { ShopAggregate, ShopProfile, OrderStatus, PayoutStatus, DocumentOrder, ReactivationRequest, RefundRequest, ShopPayout } from '../../types';
import AdminShopCard from './AdminShopCard';
import AdminPayoutModal from './AdminPayoutModal';
import AdminReferrals from './AdminReferrals';
import { Card } from '../common/Card';
import { RefundOtpModal } from '../common/RefundOtpModal';
import { AccountOtpModal } from '../common/AccountOtpModal';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import TicketList from '../tickets/TicketList';
import { adminApi, shopApi } from '../../lib/queries';
import * as api from '../../lib/api';
import { Button } from '../common/Button';
import { formatMoney } from '../../utils/money';

type AdminTab = 'overview' | 'shops' | 'reactivations' | 'payouts' | 'orders' | 'tickets' | 'refunds' | 'referrals';

type PayoutAction = 'APPROVE_PAYOUT' | 'MARK_PAID' | 'REJECT_PAYOUT' | 'CANCEL_PAYOUT';

/**
 * Copy for the payout confirmation modal, keyed by action.
 *
 * Approving and marking-as-received are deliberately worded as two different
 * things: the first initiates a bank transfer, the second records that it
 * landed. An admin who conflates them leaves shop owners staring at "on its
 * way" forever.
 */
const PAYOUT_ACTION_COPY: Record<PayoutAction, {
  title: string; verb: string; confirm: string; tone: string; note: string;
}> = {
  APPROVE_PAYOUT: {
    title: 'Approve Payout',
    verb: 'APPROVE',
    confirm: 'Confirm Approval',
    tone: 'text-emerald-600',
    note: "This marks the transfer as initiated. The shop's ledger balance was already deducted when they requested it.",
  },
  // Sent, not received. An admin knows when they made the transfer; only the
  // shop knows when it arrived, and the shop confirms that itself at this
  // stage. Asking the admin to wait for the money to land also deadlocked the
  // flow — the shop's Confirm button only appears once a payout is PAID, so a
  // payout left IN_TRANSIT could never be confirmed by anyone.
  MARK_PAID: {
    title: 'Mark Payout as Sent',
    verb: 'MARK AS SENT',
    confirm: 'Confirm Transfer Sent',
    tone: 'text-emerald-600',
    note: "Do this once you have made the bank transfer. The shop is then asked to confirm it arrived, or to raise a dispute if it never does.",
  },
  REJECT_PAYOUT: {
    title: 'Reject Payout',
    verb: 'REJECT',
    confirm: 'Confirm Rejection',
    tone: 'text-red-600',
    note: "This reverses the reservation and refunds the shop's ledger balance.",
  },
  CANCEL_PAYOUT: {
    title: 'Cancel Payout',
    verb: 'CANCEL',
    confirm: 'Confirm Cancellation',
    tone: 'text-red-600',
    note: "This reverses the reservation and refunds the shop's ledger balance.",
  },
};

const AdminDashboard: React.FC = () => {
  const { shops, allOrders, payouts, studentPassHolders, tickets, reports, reactivationRequests, resolveReactivationRequest, requestAccountActionOTP, loadMoreOrders, ordersLimit, loadMorePayouts, payoutsLimit, refundRequests, resolveRefundRequest, approvePayout, markPayoutPaid, rejectPayout, cancelPayout } = useAppContext();
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const [selectedShopForPayout, setSelectedShopForPayout] = useState<ShopProfile | null>(null);
  const [ordersSearch, setOrdersSearch] = useState('');
  const [selectedOrdersShop, setSelectedOrdersShop] = useState<string | null>(null);
  const [payoutsShopFilter, setPayoutsShopFilter] = useState<string>('all');
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

  // Reactivation request state
  const [reactivationModalRequest, setReactivationModalRequest] = useState<ReactivationRequest | null>(null);
  const [reactivationAction, setReactivationAction] = useState<'approve' | 'reject'>('approve');
  const [reactivationRejectionReason, setReactivationRejectionReason] = useState('');
  const [isReactivationProcessing, setIsReactivationProcessing] = useState(false);
  const [isReactivationOTPRequesting, setIsReactivationOTPRequesting] = useState(false);
  const [reactivationOTPSent, setReactivationOTPSent] = useState(false);
  const [reactivationResult, setReactivationResult] = useState<{ success: boolean; message: string } | null>(null);

  // Admin Refund Request State
  const [adminRefundModalReq, setAdminRefundModalReq] = useState<RefundRequest | null>(null);
  const [adminRefundAction, setAdminRefundAction] = useState<'APPROVE' | 'DENY'>('APPROVE');
  const [adminRefundNote, setAdminRefundNote] = useState('');
  const [isAdminRefundProcessing, setIsAdminRefundProcessing] = useState(false);
  const [isAdminRefundOTPRequesting, setIsAdminRefundOTPRequesting] = useState(false);
  const [adminRefundOTPSent, setAdminRefundOTPSent] = useState(false);
  const [adminRefundResult, setAdminRefundResult] = useState<{ success: boolean; message: string } | null>(null);

  // Admin Payout Request State
  const [adminPayoutModalReq, setAdminPayoutModalReq] = useState<ShopPayout | null>(null);
  const [adminPayoutAction, setAdminPayoutAction] = useState<'APPROVE_PAYOUT' | 'MARK_PAID' | 'REJECT_PAYOUT' | 'CANCEL_PAYOUT'>('APPROVE_PAYOUT');
  const [adminPayoutNote, setAdminPayoutNote] = useState('');
  const [isAdminPayoutProcessing, setIsAdminPayoutProcessing] = useState(false);
  const [isAdminPayoutOTPRequesting, setIsAdminPayoutOTPRequesting] = useState(false);
  const [adminPayoutOTPSent, setAdminPayoutOTPSent] = useState(false);
  const [adminPayoutResult, setAdminPayoutResult] = useState<{ success: boolean; message: string } | null>(null);
  const [shopAggregatesMap, setShopAggregatesMap] = useState<Record<string, ShopAggregate>>({});
  const adminPayoutCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const adminRefundCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reactivationCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aggregateBackfillKeyRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    const fetchAggregates = async () => {
      try {
        // Fetch aggregate for each shop
        const results = await Promise.allSettled(
          shops.map(shop => shopApi.getAggregate(shop.id))
        );
        if (cancelled) return;
        const next: Record<string, ShopAggregate> = {};
        results.forEach((result, idx) => {
          if (result.status === 'fulfilled' && result.value) {
            next[shops[idx].id] = result.value;
          }
        });
        setShopAggregatesMap(next);
      } catch { /* ignore */ }
    };
    if (shops.length > 0) fetchAggregates();
    const interval = setInterval(fetchAggregates, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [shops]);

  useEffect(() => {
    const missingShopIds = shops
      .filter((shop) => !shopAggregatesMap[shop.id])
      .map((shop) => shop.id)
      .sort();

    if (missingShopIds.length === 0) {
      aggregateBackfillKeyRef.current = '';
      return;
    }

    const nextKey = missingShopIds.join('|');
    if (aggregateBackfillKeyRef.current === nextKey) return;
    aggregateBackfillKeyRef.current = nextKey;

    // Debounce: wait 3s before triggering rebuild to avoid firing on rapid state changes
    const timer = setTimeout(() => {
      void api.post('/admin/rebuild-aggregates').catch(() => {
        aggregateBackfillKeyRef.current = '';
      });
    }, 3000);

    return () => clearTimeout(timer);
  }, [shopAggregatesMap, shops]);

  useEffect(() => () => {
    if (adminPayoutCloseTimerRef.current) clearTimeout(adminPayoutCloseTimerRef.current);
    if (adminRefundCloseTimerRef.current) clearTimeout(adminRefundCloseTimerRef.current);
    if (reactivationCloseTimerRef.current) clearTimeout(reactivationCloseTimerRef.current);
  }, []);

  const getRefundImpact = useCallback((order: DocumentOrder | null) => {
    if (!order) return null;
    const shop = shops.find((entry) => entry.id === order.shopId);
    const deductionAmount = order.priceDetails?.pageCost || 0;
    const ledgerBalance = shop?.ledgerBalance || 0;
    const pendingBalance = shop?.pendingBalance || 0;
    const willGoNegative = ledgerBalance - deductionAmount < 0;
    const alreadyPaidOut = payouts.some((payout) =>
      payout.shopId === order.shopId &&
      ![PayoutStatus.REJECTED, PayoutStatus.CANCELLED].includes(payout.status) &&
      Array.isArray(payout.payoutOrderIds) &&
      payout.payoutOrderIds.includes(order.id)
    );

    return {
      shopName: shop?.name || order.shopId,
      ledgerBalance,
      pendingBalance,
      deductionAmount,
      willGoNegative,
      alreadyPaidOut,
    };
  }, [shops, payouts]);

  const refundModalImpact = useMemo(() => getRefundImpact(refundModalOrder), [refundModalOrder, getRefundImpact]);
  const refundRequestOrder = useMemo(
    () => allOrders.find((order) => order.id === adminRefundModalReq?.orderId) || null,
    [allOrders, adminRefundModalReq]
  );
  const adminRefundImpact = useMemo(() => getRefundImpact(refundRequestOrder), [refundRequestOrder, getRefundImpact]);
  const shopAggregates = useMemo(() => Object.values(shopAggregatesMap), [shopAggregatesMap]);
  useGSAP(() => {
    const cards = dashboardRef.current?.querySelectorAll(".admin-card");
    if (!cards || cards.length === 0) return;
    gsap.fromTo(cards, 
      { y: 20, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.6, stagger: 0.08, ease: "power3.out", clearProps: "opacity,transform" }
    );
  }, { scope: dashboardRef, dependencies: [activeTab, shops.length] });

  // Computed stats
  const stats = useMemo(() => {
    const aggregateShopIds = new Set(Object.keys(shopAggregatesMap));
    const fallbackOrders = allOrders.filter((order) => !aggregateShopIds.has(order.shopId));
    const fallbackCompletedOrders = fallbackOrders.filter((order) => order.status === OrderStatus.COMPLETED);
    const fallbackActiveOrders = fallbackOrders.filter((order) =>
      order.status !== OrderStatus.COMPLETED &&
      order.status !== OrderStatus.CANCELLED &&
      order.status !== OrderStatus.REFUNDED &&
      order.status !== OrderStatus.PAYMENT_FAILED &&
      order.status !== OrderStatus.PENDING_PAYMENT
    );
    const fallbackPayouts = payouts.filter((payout) => !aggregateShopIds.has(payout.shopId));
    const fallbackPaidOut = fallbackPayouts
      .filter((payout) => payout.status === PayoutStatus.IN_TRANSIT || payout.status === PayoutStatus.PAID || payout.status === PayoutStatus.CONFIRMED)
      .reduce((sum, payout) => sum + payout.amount, 0);
    const fallbackPendingPayouts = fallbackPayouts.filter((payout) => payout.status === PayoutStatus.PENDING).length;

    const totalOrders = shopAggregates.reduce((sum, aggregate) => sum + aggregate.totalOrders, 0) + fallbackOrders.length;
    const shopEarnings = shopAggregates.reduce((sum, aggregate) => sum + aggregate.totalRevenue, 0) +
      fallbackCompletedOrders.reduce((sum, order) => sum + (order.priceDetails?.pageCost || 0), 0);
    const platformFees = shopAggregates.reduce((sum, aggregate) => sum + aggregate.totalBaseFees, 0) +
      fallbackCompletedOrders.reduce((sum, order) => sum + (order.priceDetails?.baseFee || 0), 0);
    const totalRevenue = shopEarnings + platformFees;
    const activeOrders = shopAggregates.reduce((sum, aggregate) => sum + aggregate.activeOrders, 0) + fallbackActiveOrders.length;
    const pendingPayouts = shopAggregates.reduce((sum, aggregate) => sum + aggregate.pendingPayoutCount, 0) + fallbackPendingPayouts;
    const disputedPayouts = payouts.filter(p => p.status === PayoutStatus.DISPUTED).length;
    const totalPaidOut = shopAggregates.reduce((sum, aggregate) => sum + aggregate.totalPaidOut, 0) + fallbackPaidOut;

    const pendingApprovals = shops.filter(s => !s.isApproved && !s.isArchived).length;

    // Subscription revenue
    const totalPassHolders = studentPassHolders.length;
    const subscriptionRevenue = totalPassHolders * 4900; // ₹49 per pass, in paise

    return { totalOrders, totalRevenue, shopEarnings, platformFees, activeOrders, pendingPayouts, disputedPayouts, totalPaidOut, activeShops: shops.filter(s => s.isOpen).length, pendingApprovals, totalPassHolders, subscriptionRevenue };
  }, [allOrders, payouts, shopAggregates, shopAggregatesMap, shops, studentPassHolders]);

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
      case OrderStatus.REFUNDED: return 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-400';
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
      case PayoutStatus.IN_TRANSIT: return 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400';
      case PayoutStatus.PAID: return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400';
      case PayoutStatus.CONFIRMED: return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400';
      case PayoutStatus.DISPUTED: return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400';
      case PayoutStatus.CANCELLED: return 'bg-slate-100 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 line-through opacity-75';
      case PayoutStatus.REJECTED: return 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400 line-through opacity-75';
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
      await adminApi.requestOTP(`refund_${refundModalOrder.id}`);
      setOtpSent(true);
      setRefundResult({ success: true, message: 'OTP sent! Please check your admin mailbox.' });
    } catch (err) {
      const error = err as Error;
      setRefundResult({ success: false, message: error.message || 'Failed to send OTP.' });
    }
    setIsRequestingOTP(false);
  };

  // Handle confirming refund with OTP
  const handleConfirmRefund = async (enteredOtp: string) => {
    if (!refundModalOrder || !enteredOtp.trim()) return;
    setIsIssuingRefund(true);
    setRefundResult(null);
    try {
      const data = await adminApi.executeAction('initiateRefund', enteredOtp.trim(), undefined, undefined) as unknown as { success: boolean; message: string };
      setRefundResult({ success: true, message: data.message || 'Refund initiated successfully.' });
      setOtpSent(false); // Reset
    } catch (err) {
      const error = err as Error;
      setRefundResult({ success: false, message: error.message || 'Refund failed. Invalid OTP?' });
    }
    setIsIssuingRefund(false);
  };

  const tabs: { key: AdminTab; label: string; icon: React.ReactNode }[] = [
    { key: 'overview', label: 'Overview', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M11.47 3.841a.75.75 0 0 1 1.06 0l8.69 8.69a.75.75 0 1 0 1.06-1.061l-8.689-8.69a2.25 2.25 0 0 0-3.182 0l-8.69 8.69a.75.75 0 1 0 1.061 1.06l8.69-8.689Z" /><path d="m12 5.432 8.159 8.159c.03.03.06.058.091.086v6.198c0 1.035-.84 1.875-1.875 1.875H15a.75.75 0 0 1-.75-.75v-4.5a.75.75 0 0 0-.75-.75h-3a.75.75 0 0 0-.75.75V21a.75.75 0 0 1-.75.75H5.625a1.875 1.875 0 0 1-1.875-1.875v-6.198a2.29 2.29 0 0 0 .091-.086L12 5.432Z" /></svg> },
    { key: 'shops', label: 'Shops', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M5.223 2.25h13.554a.75.75 0 0 1 .678.427l2.443 5.145a.75.75 0 0 1 .072.323v.5c0 1.59-.81 2.994-2.04 3.815v8.29a.75.75 0 0 1-.75.75H4.82a.75.75 0 0 1-.75-.75v-8.29a4.41 4.41 0 0 1-2.04-3.815v-.5a.75.75 0 0 1 .072-.323l2.443-5.145a.75.75 0 0 1 .678-.427Z" /></svg> },
    { key: 'payouts', label: 'Payouts', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M2.273 5.625A4.483 4.483 0 0 1 5.25 4.5h13.5c1.141 0 2.183.425 2.977 1.125A3 3 0 0 0 18.75 3H5.25a3 3 0 0 0-2.977 2.625ZM2.273 8.625A4.483 4.483 0 0 1 5.25 7.5h13.5c1.141 0 2.183.425 2.977 1.125A3 3 0 0 0 18.75 6H5.25a3 3 0 0 0-2.977 2.625ZM5.25 9a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h13.5a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3H15a.75.75 0 0 0-.75.75 2.25 2.25 0 0 1-4.5 0A.75.75 0 0 0 9 9H5.25Z" /></svg> },
    { key: 'orders', label: 'All Orders', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M7.502 6h7.128A3.375 3.375 0 0 1 18 9.375v9.375a3 3 0 0 0 3-3V6.108c0-1.505-1.125-2.811-2.664-2.94a48.972 48.972 0 0 0-.673-.05A3 3 0 0 0 15 1.5h-1.5a3 3 0 0 0-2.663 1.618c-.225.015-.45.032-.673.05C8.662 3.295 7.554 4.542 7.502 6ZM13.5 3A1.5 1.5 0 0 0 12 4.5h4.5A1.5 1.5 0 0 0 15 3h-1.5Z" clipRule="evenodd" /><path fillRule="evenodd" d="M3 9.375C3 8.339 3.84 7.5 4.875 7.5h9.75c1.036 0 1.875.84 1.875 1.875v11.25c0 1.035-.84 1.875-1.875 1.875h-9.75A1.875 1.875 0 0 1 3 20.625V9.375Zm9.586 4.594a.75.75 0 0 0-1.172-.938l-2.476 3.096-.908-.907a.75.75 0 0 0-1.06 1.06l1.5 1.5a.75.75 0 0 0 1.116-.062l3-3.75Z" clipRule="evenodd" /></svg> },
    { key: 'tickets', label: 'Tickets', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0 1 12 2.25c2.43 0 4.817.178 7.152.52a1.834 1.834 0 0 1 1.529 1.657l.293 3.513a1.834 1.834 0 0 1-1.307 1.92l-.416.14a3.118 3.118 0 0 0-1.898 4.084l.108.27a1.835 1.835 0 0 1-.9 2.267l-3.19 1.595a1.835 1.835 0 0 1-2.118-.355L9.69 16.3a3.118 3.118 0 0 0-4.253-.143l-.295.268a1.834 1.834 0 0 1-2.445-.198l-1.06-1.162a1.834 1.834 0 0 1-.286-2.066l.168-.336a3.118 3.118 0 0 0-1.034-3.82l-.35-.247A1.834 1.834 0 0 1 .26 6.62l.592-3.209a1.835 1.835 0 0 1 1.532-1.494l2.464-.146Z" clipRule="evenodd" /></svg> },
    { key: 'reactivations', label: 'Reactivations', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M4.755 10.059a7.5 7.5 0 0 1 12.548-3.364l1.903 1.903h-3.183a.75.75 0 1 0 0 1.5h4.992a.75.75 0 0 0 .75-.75V4.356a.75.75 0 0 0-1.5 0v3.18l-1.9-1.9A9 9 0 0 0 3.306 9.67a.75.75 0 1 0 1.45.388Zm14.49 3.882a7.5 7.5 0 0 1-12.548 3.364l-1.902-1.903h3.183a.75.75 0 0 0 0-1.5H2.984a.75.75 0 0 0-.75.75v4.992a.75.75 0 0 0 1.5 0v-3.18l1.9 1.9a9 9 0 0 0 15.059-4.035.75.75 0 0 0-1.45-.388Z" clipRule="evenodd" /></svg> },
    { key: 'refunds', label: 'Refunds', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM9.204 10.97a.75.75 0 0 1 .157-1.049 4.496 4.496 0 0 1 5.278 0 .75.75 0 0 1-.92 1.157 2.997 2.997 0 0 0-3.518 0 .75.75 0 0 1-1.049-.158H9.204ZM12 7.125a1.125 1.125 0 1 0 0 2.25 1.125 1.125 0 0 0 0-2.25Z" clipRule="evenodd" /></svg> },
    { key: 'referrals', label: 'Referrals', icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M15.75 4.5a3 3 0 1 1 .825 2.066l-8.421 4.679a3.002 3.002 0 0 1 0 1.51l8.421 4.679a3 3 0 1 1-.729 1.31l-8.421-4.678a3 3 0 1 1 0-4.132l8.421-4.679a3 3 0 0 1-.096-.755Z" clipRule="evenodd" /></svg> },
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
              <p className="text-3xl font-bold text-blue-700 dark:text-blue-300 mt-1">{formatMoney(stats.totalRevenue)}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{stats.totalOrders} orders</p>
            </div>
            <div className="admin-card bg-gradient-to-br from-emerald-50 to-green-50 dark:from-emerald-900/20 dark:to-green-900/20 rounded-xl p-5 border border-emerald-200/50 dark:border-emerald-800/30">
              <p className="text-xs font-semibold text-emerald-600/70 dark:text-emerald-400/70 uppercase tracking-wider">Platform Fees</p>
              <p className="text-3xl font-bold text-emerald-700 dark:text-emerald-300 mt-1">{formatMoney(stats.platformFees)}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Your earnings</p>
            </div>
            <div className="admin-card bg-gradient-to-br from-amber-50 to-yellow-50 dark:from-amber-900/20 dark:to-yellow-900/20 rounded-xl p-5 border border-amber-200/50 dark:border-amber-800/30">
              <p className="text-xs font-semibold text-amber-600/70 dark:text-amber-400/70 uppercase tracking-wider">Paid to Shops</p>
              <p className="text-3xl font-bold text-amber-700 dark:text-amber-300 mt-1">{formatMoney(stats.totalPaidOut)}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Total settled</p>
            </div>
            <div className="admin-card bg-gradient-to-br from-purple-50 to-violet-50 dark:from-purple-900/20 dark:to-violet-900/20 rounded-xl p-5 border border-purple-200/50 dark:border-purple-800/30">
              <p className="text-xs font-semibold text-purple-600/70 dark:text-purple-400/70 uppercase tracking-wider">Active Shops</p>
              <p className="text-3xl font-bold text-purple-700 dark:text-purple-300 mt-1">{stats.activeShops}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">of {shops.length} total</p>
            </div>
            <div className="admin-card bg-gradient-to-br from-rose-50 to-pink-50 dark:from-rose-900/20 dark:to-pink-900/20 rounded-xl p-5 border border-rose-200/50 dark:border-rose-800/30">
              <p className="text-xs font-semibold text-rose-600/70 dark:text-rose-400/70 uppercase tracking-wider">Student Pass Revenue</p>
              <p className="text-3xl font-bold text-rose-700 dark:text-rose-300 mt-1">{formatMoney(stats.subscriptionRevenue)}</p>
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
                <p className="text-4xl font-bold text-gray-900 dark:text-white">{formatMoney(stats.shopEarnings)}</p>
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
                  <span className="text-sm font-bold text-rose-600 dark:text-rose-400">{formatMoney(stats.subscriptionRevenue)} total</span>
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
                      const data = await api.post<{ downloadUrl?: string }>('/admin/earnings-report', {
                        startDate: new Date(reportStartDate).toISOString(),
                        endDate: new Date(reportEndDate + 'T23:59:59').toISOString(),
                        reportType: 'full',
                      });
                      if (data.downloadUrl) {
                        window.open(data.downloadUrl, '_blank');
                      }
                    } catch (err) {
                      const error = err as Error;
                      setReportError(error.message || 'Failed to generate report.');
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
                        {report.totalOrders} orders • {formatMoney(report.totalRevenue)} revenue
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
                        <td className="p-4 font-bold text-gray-900 dark:text-white">{formatMoney(payout.amount)}</td>
                        <td className="p-4">
                          <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${getPayoutStatusColor(payout.status)}`}>
                            {payout.status}
                          </span>
                        </td>
                        <td className="p-4 text-gray-500 dark:text-gray-400 max-w-[200px] truncate">
                          {payout.adminNote || '—'}
                          {payout.shopOwnerNote && <span className="block text-xs text-red-500 mt-1">Shop: {payout.shopOwnerNote}</span>}
                          
                          {payout.status === 'PENDING' && (
                            <div className="flex gap-2 mt-2">
                              <Button
                                size="sm"
                                variant="primary"
                                className="!py-1"
                                onClick={() => {
                                  setAdminPayoutModalReq(payout);
                                  setAdminPayoutAction('APPROVE_PAYOUT');
                                  setAdminPayoutNote('');
                                  setAdminPayoutResult(null);
                                }}
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                className="!py-1"
                                onClick={() => {
                                  setAdminPayoutModalReq(payout);
                                  setAdminPayoutAction('REJECT_PAYOUT');
                                  setAdminPayoutNote('');
                                  setAdminPayoutResult(null);
                                }}
                              >
                                Reject
                              </Button>
                            </div>
                          )}

                          {payout.status === 'IN_TRANSIT' && (
                            <div className="flex gap-2 mt-2">
                              <Button
                                size="sm"
                                variant="primary"
                                className="!py-1"
                                onClick={() => {
                                  setAdminPayoutModalReq(payout);
                                  setAdminPayoutAction('MARK_PAID');
                                  setAdminPayoutNote('');
                                  setAdminPayoutResult(null);
                                }}
                              >
                                Mark as Sent
                              </Button>
                            </div>
                          )}

                          {payout.status === 'DISPUTED' && (
                            <div className="flex gap-2 mt-2">
                              <Button
                                size="sm"
                                variant="danger"
                                className="!py-1"
                                onClick={() => {
                                  setAdminPayoutModalReq(payout);
                                  setAdminPayoutAction('CANCEL_PAYOUT');
                                  setAdminPayoutNote('');
                                  setAdminPayoutResult(null);
                                }}
                              >
                                Cancel &amp; Refund
                              </Button>
                            </div>
                          )}
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
          {payouts.length >= payoutsLimit && (
            <div className="flex justify-center mt-4 mb-8">
              <Button variant="secondary" onClick={loadMorePayouts}>Load More Payouts</Button>
            </div>
          )}

          {/* Admin Payout Server-Side Action Modal */}
          {adminPayoutModalReq && (
            <AccountOtpModal
              isOpen={!!adminPayoutModalReq}
              onClose={() => setAdminPayoutModalReq(null)}
              title={PAYOUT_ACTION_COPY[adminPayoutAction].title}
              description={
                <div>
                  <p>You are about to <strong>{PAYOUT_ACTION_COPY[adminPayoutAction].verb}</strong> a payout for <span className="font-bold">{adminPayoutModalReq.shopName}</span>.</p>
                  <p className="mt-1">Amount: <strong>{formatMoney(adminPayoutModalReq.amount)}</strong></p>
                  <p className={`${PAYOUT_ACTION_COPY[adminPayoutAction].tone} mt-1 text-xs`}>
                    {PAYOUT_ACTION_COPY[adminPayoutAction].note}
                  </p>
                  <div className="mt-3">
                    <label className="block text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">Admin Note (optional)</label>
                    <input
                      type="text"
                      className="w-full px-3 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-brand-primary outline-none"
                      placeholder="Reason or reference..."
                      value={adminPayoutNote}
                      onChange={(e) => setAdminPayoutNote(e.target.value)}
                    />
                  </div>
                </div>
              }
              confirmText={PAYOUT_ACTION_COPY[adminPayoutAction].confirm}
              loadingText="Processing..."
              isProcessing={isAdminPayoutProcessing}
              isRequestingOTP={isAdminPayoutOTPRequesting}
              otpSent={adminPayoutOTPSent}
              resultMessage={adminPayoutResult}
              onRequestOTP={async () => {
                setIsAdminPayoutOTPRequesting(true);
                setAdminPayoutResult(null);
                const res = await requestAccountActionOTP(`payout_${adminPayoutModalReq.id}`);
                setIsAdminPayoutOTPRequesting(false);
                if (res.success) {
                  setAdminPayoutOTPSent(true);
                } else {
                  setAdminPayoutResult({ success: false, message: res.message || "Failed to send OTP" });
                }
              }}
              onConfirm={async (otp) => {
                setIsAdminPayoutProcessing(true);
                setAdminPayoutResult(null);
                
                let res;
                if (adminPayoutAction === 'APPROVE_PAYOUT') {
                  res = await approvePayout(adminPayoutModalReq.id, otp, adminPayoutNote);
                } else if (adminPayoutAction === 'MARK_PAID') {
                  res = await markPayoutPaid(adminPayoutModalReq.id, otp, adminPayoutNote);
                } else if (adminPayoutAction === 'REJECT_PAYOUT') {
                  res = await rejectPayout(adminPayoutModalReq.id, otp, adminPayoutNote);
                } else {
                  res = await cancelPayout(adminPayoutModalReq.id, otp);
                }
                
                setIsAdminPayoutProcessing(false);
                if (res.success) {
                  setAdminPayoutResult({ success: true, message: res.message || "Resolved successfully." });
                  adminPayoutCloseTimerRef.current = setTimeout(() => setAdminPayoutModalReq(null), 2000);
                } else {
                  setAdminPayoutResult({ success: false, message: res.message || "Failed to resolve." });
                }
              }}
            />
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
                  const aggregate = shopAggregatesMap[shop.id];
                  const shopOrderCount = aggregate?.totalOrders ?? allOrders.filter(o => o.shopId === shop.id).length;
                  const activeCount = aggregate?.activeOrders ?? allOrders.filter(o => o.shopId === shop.id && o.status !== OrderStatus.COMPLETED && o.status !== OrderStatus.CANCELLED && o.status !== OrderStatus.REFUNDED && o.status !== OrderStatus.PAYMENT_FAILED && o.status !== OrderStatus.PENDING_PAYMENT).length;
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
                                <td className="p-4 font-bold text-gray-900 dark:text-white">{formatMoney(order.priceDetails.totalPrice)}</td>
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
                                                  <p className="text-sm font-bold text-gray-900 dark:text-white">{formatMoney(order.refundAmount)}</p>
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
                  {allOrders.length >= ordersLimit && (
                    <div className="p-4 flex justify-center border-t border-gray-200 dark:border-zinc-700">
                      <button
                        onClick={loadMoreOrders}
                        className="px-5 py-2 text-sm font-medium text-brand-primary bg-brand-primary/10 hover:bg-brand-primary/20 rounded-lg transition-colors"
                      >
                        Load More Orders From Server
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

      {/* ===== REACTIVATIONS TAB ===== */}
      {activeTab === 'reactivations' && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Reactivation Requests ({reactivationRequests.length})</h3>
          
          {/* Pending Requests */}
          {(() => {
            const pending = reactivationRequests.filter(r => r.status === 'pending');
            const resolved = reactivationRequests.filter(r => r.status !== 'pending');
            return (
              <>
                {pending.length > 0 ? (
                  <div className="space-y-3">
                    <h4 className="text-sm font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider">Pending ({pending.length})</h4>
                    {pending.map(req => (
                      <Card key={req.id} className="bg-white dark:bg-zinc-900 border border-amber-200 dark:border-amber-800/50 p-4">
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <h4 className="font-semibold text-gray-900 dark:text-white truncate">🏪 {req.shopName}</h4>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                              {req.ownerName} • {req.ownerEmail}
                            </p>
                            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                              Requested: {new Date(req.requestedAt).toLocaleString()}
                            </p>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => {
                                setReactivationModalRequest(req);
                                setReactivationAction('approve');
                                setReactivationRejectionReason('');
                                setReactivationResult(null);
                                setReactivationOTPSent(false);
                              }}
                              className="!bg-gradient-to-r !from-emerald-500 !to-green-600"
                            >
                              ✅ Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setReactivationModalRequest(req);
                                setReactivationAction('reject');
                                setReactivationRejectionReason('');
                                setReactivationResult(null);
                                setReactivationOTPSent(false);
                              }}
                              className="!text-red-600 !border-red-300 dark:!text-red-400 dark:!border-red-800"
                            >
                              ❌ Reject
                            </Button>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <Card className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-center py-8">
                    <p className="text-gray-500 dark:text-gray-400">No pending reactivation requests.</p>
                  </Card>
                )}

                {/* Resolved History */}
                {resolved.length > 0 && (
                  <details className="mt-6">
                    <summary className="text-sm font-semibold text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
                      📜 Resolved History ({resolved.length})
                    </summary>
                    <div className="space-y-2 mt-3">
                      {resolved.map(req => (
                        <Card key={req.id} className={`bg-white dark:bg-zinc-900 border p-3 ${
                          req.status === 'approved' ? 'border-emerald-200 dark:border-emerald-800/40' : 'border-red-200 dark:border-red-800/40'
                        }`}>
                          <div className="flex items-center justify-between">
                            <div>
                              <h4 className="text-sm font-medium text-gray-900 dark:text-white">{req.shopName}</h4>
                              <p className="text-xs text-gray-500 dark:text-gray-400">{req.ownerEmail}</p>
                              {req.rejectionReason && (
                                <p className="text-xs text-red-500 mt-0.5">Reason: {req.rejectionReason}</p>
                              )}
                            </div>
                            <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
                              req.status === 'approved'
                                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                                : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                            }`}>
                              {req.status === 'approved' ? '✅ Approved' : '❌ Rejected'}
                            </span>
                          </div>
                          {req.resolvedAt && (
                            <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">
                              Resolved: {new Date(req.resolvedAt).toLocaleString()}
                            </p>
                          )}
                        </Card>
                      ))}
                    </div>
                  </details>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* ===== REFUNDS TAB ===== */}
      {activeTab === 'refunds' && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Escalated Refund Requests</h3>
          <div className="space-y-3">
            {refundRequests.filter(req => ['ESCALATED_TO_ADMIN', 'AUTO_ESCALATED', 'APPROVED_BY_SHOP'].includes(req.status)).length > 0 ? (
              refundRequests.filter(req => ['ESCALATED_TO_ADMIN', 'AUTO_ESCALATED', 'APPROVED_BY_SHOP'].includes(req.status)).map(req => {
                return (
                  <Card key={req.id} className="bg-white dark:bg-zinc-900 border border-red-200 dark:border-red-800/50 p-4">
                    <div className="flex justify-between items-start mb-2">
                       <div>
                         <h4 className="font-semibold text-gray-900 dark:text-white truncate">Order #{req.orderId.slice(-6)}</h4>
                         <p className="text-xs text-gray-500">Student: {req.studentId.slice(-6)} • Shop: {req.shopId.slice(-6)}</p>
                       </div>
                       <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase bg-red-100 text-red-800">
                         {req.status.replace(/_/g, ' ')}
                       </span>
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-2"><strong className="text-gray-900 dark:text-gray-200">Reason:</strong> {req.reason}</p>
                    {req.shopResponse && (
                      <div className="bg-gray-50 dark:bg-zinc-800 p-2 rounded text-xs text-gray-600 dark:text-gray-400 mb-3 border border-gray-100 dark:border-zinc-700">
                        <strong>Shop Response:</strong> {req.shopResponse}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Button variant="primary" size="sm" onClick={() => {
                        setAdminRefundModalReq(req);
                        setAdminRefundAction('APPROVE');
                        setAdminRefundNote('');
                        setAdminRefundResult(null);
                        setAdminRefundOTPSent(false);
                      }}>Issue Refund</Button>
                      <Button variant="danger" size="sm" onClick={() => {
                        setAdminRefundModalReq(req);
                        setAdminRefundAction('DENY');
                        setAdminRefundNote('');
                        setAdminRefundResult(null);
                        setAdminRefundOTPSent(false);
                      }}>Reject Request</Button>
                    </div>
                  </Card>
                );
              })
            ) : (
               <Card className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-center py-8">
                 <p className="text-gray-500 dark:text-gray-400">No escalated refund requests right now.</p>
               </Card>
            )}
          </div>
        </div>
      )}

      {/* ===== TICKETS TAB ===== */}
      {activeTab === 'tickets' && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Support Tickets ({tickets.length})</h3>
          <TicketList tickets={tickets} showRaiserInfo />
        </div>
      )}

      {/* ===== REFERRALS TAB ===== */}
      {activeTab === 'referrals' && <AdminReferrals />}

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
              <span className="text-lg font-bold text-gray-900 dark:text-white">{formatMoney(refundModalOrder.priceDetails.totalPrice)}</span>
            </div>
          </div>

          {refundModalImpact && (
            <div className={`mb-4 rounded-xl border p-4 ${refundModalImpact.willGoNegative ? 'border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-900/20' : 'border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/20'}`}>
              <p className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Shop Financial Impact</p>
              <div className="space-y-1 text-xs text-gray-700 dark:text-gray-300">
                <p>Shop: <strong>{refundModalImpact.shopName}</strong></p>
                <p>Current ledger balance: <strong>{formatMoney(refundModalImpact.ledgerBalance)}</strong></p>
                <p>Current pending balance: <strong>{formatMoney(refundModalImpact.pendingBalance)}</strong></p>
                <p>Shop earning reversal for this refund: <strong>{formatMoney(refundModalImpact.deductionAmount)}</strong></p>
                <p className={refundModalImpact.willGoNegative ? 'text-red-700 dark:text-red-300 font-semibold' : ''}>
                  Negative balance risk: <strong>{refundModalImpact.willGoNegative ? 'Yes' : 'No'}</strong>
                </p>
                {refundModalImpact.alreadyPaidOut && (
                  <p className="text-red-700 dark:text-red-300 font-semibold">
                    Warning: this order is already linked to a payout snapshot.
                  </p>
                )}
              </div>
            </div>
          )}

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
              ⚠️ This will issue a full refund of <strong>{formatMoney(refundModalOrder.priceDetails.totalPrice)}</strong> to the student's original payment method. The refund typically takes 5-7 business days.
            </p>
          </div>
        </RefundOtpModal>
      )}
      {/* Admin Refund OTP Modal */}
      {adminRefundModalReq && (
        <AccountOtpModal
          isOpen={!!adminRefundModalReq}
          onClose={() => { setAdminRefundModalReq(null); setAdminRefundResult(null); setAdminRefundOTPSent(false); setAdminRefundNote(''); }}
          title={adminRefundAction === 'APPROVE' ? `Issue External Refund` : `Reject Refund Request`}
          description={
            <>
              <p className="mb-2">
                {adminRefundAction === 'APPROVE'
                  ? <>You are about to issue a <strong>full refund</strong> for order <strong>#{adminRefundModalReq.orderId.slice(-6)}</strong>. This action is irreversible.</>
                  : <>You are about to <strong>reject</strong> this refund request. The student will be notified.</>}
              </p>
              <p className="text-xs text-amber-500 font-semibold mb-2">OTP verification is required.</p>
            </>
          }
          confirmText={adminRefundAction === 'APPROVE' ? 'Verify & Refund' : 'Verify & Reject'}
          loadingText="Processing..."
          onConfirm={async (otp) => {
            setIsAdminRefundProcessing(true);
            const result = await resolveRefundRequest(
              adminRefundModalReq.id,
              adminRefundAction,
              otp,
              adminRefundNote || undefined
            );
            setIsAdminRefundProcessing(false);
            setAdminRefundResult({ success: result.success, message: result.message || (result.success ? 'Success!' : 'Failed.') });
            if (result.success) {
              adminRefundCloseTimerRef.current = setTimeout(() => { setAdminRefundModalReq(null); setAdminRefundResult(null); setAdminRefundOTPSent(false); }, 2000);
            }
          }}
          onRequestOTP={async () => {
            setIsAdminRefundOTPRequesting(true);
            const result = await requestAccountActionOTP(`refund_${adminRefundModalReq?.id ?? ''}`);
            setIsAdminRefundOTPRequesting(false);
            if (result.success) {
              setAdminRefundOTPSent(true);
            } else {
              setAdminRefundResult({ success: false, message: result.message || 'Failed to send OTP.' });
            }
          }}
          isProcessing={isAdminRefundProcessing}
          isRequestingOTP={isAdminRefundOTPRequesting}
          otpSent={adminRefundOTPSent}
          resultMessage={adminRefundResult}
        >
          {adminRefundImpact && (
            <div className={`mb-4 rounded-xl border p-4 ${adminRefundImpact.willGoNegative ? 'border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-900/20' : 'border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/20'}`}>
              <p className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Shop Financial Impact</p>
              <div className="space-y-1 text-xs text-gray-700 dark:text-gray-300">
                <p>Current ledger balance: <strong>{formatMoney(adminRefundImpact.ledgerBalance)}</strong></p>
                <p>Current pending balance: <strong>{formatMoney(adminRefundImpact.pendingBalance)}</strong></p>
                <p>Shop earning reversal for this refund: <strong>{formatMoney(adminRefundImpact.deductionAmount)}</strong></p>
                <p className={adminRefundImpact.willGoNegative ? 'text-red-700 dark:text-red-300 font-semibold' : ''}>
                  Negative balance risk: <strong>{adminRefundImpact.willGoNegative ? 'Yes' : 'No'}</strong>
                </p>
                {adminRefundImpact.willGoNegative && (
                  <p className="text-red-700 dark:text-red-300 font-semibold">
                    Warning: this refund will push the shop’s current ledger below zero.
                  </p>
                )}
                {adminRefundImpact.alreadyPaidOut && (
                  <p className="text-red-700 dark:text-red-300 font-semibold">
                    Warning: this order is already linked to a payout snapshot.
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {adminRefundAction === 'APPROVE' ? 'Reason (optional)' : 'Reason (required)'}
            </label>
            <textarea
              value={adminRefundNote}
              onChange={(e) => setAdminRefundNote(e.target.value)}
              placeholder={adminRefundAction === 'APPROVE' ? "Internal audit note..." : "Reason for rejection..."}
              rows={2}
              className="w-full px-3 py-2 rounded-lg bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-primary text-sm resize-none"
            />
          </div>
        </AccountOtpModal>
      )}

      {/* Reactivation OTP Modal */}
      {reactivationModalRequest && (
        <AccountOtpModal
          isOpen={!!reactivationModalRequest}
          onClose={() => { setReactivationModalRequest(null); setReactivationResult(null); setReactivationOTPSent(false); setReactivationRejectionReason(''); }}
          title={reactivationAction === 'approve' ? `Approve Reactivation` : `Reject Reactivation`}
          description={
            <>
              <p className="mb-2">
                {reactivationAction === 'approve'
                  ? <>You are about to <strong>approve</strong> the reactivation of shop <strong>"{reactivationModalRequest.shopName}"</strong> for {reactivationModalRequest.ownerEmail}.  The shop will be unarchived and the owner will regain access.</>
                  : <>You are about to <strong>reject</strong> the reactivation of shop <strong>"{reactivationModalRequest.shopName}"</strong>. The owner will be notified.</>}
              </p>
              <p className="text-xs text-gray-500">OTP verification is required to proceed.</p>
            </>
          }
          confirmText={reactivationAction === 'approve' ? 'Approve Reactivation' : 'Reject Reactivation'}
          loadingText="Processing..."
          onConfirm={async (otp) => {
            setIsReactivationProcessing(true);
            const result = await resolveReactivationRequest(
              reactivationModalRequest.id,
              reactivationAction,
              otp,
              reactivationAction === 'reject' ? reactivationRejectionReason : undefined
            );
            setIsReactivationProcessing(false);
            setReactivationResult({ success: result.success, message: result.message || (result.success ? 'Done!' : 'Failed.') });
            if (result.success) {
              reactivationCloseTimerRef.current = setTimeout(() => { setReactivationModalRequest(null); setReactivationResult(null); setReactivationOTPSent(false); }, 2000);
            }
          }}
          onRequestOTP={async () => {
            setIsReactivationOTPRequesting(true);
            const result = await requestAccountActionOTP(`reactivation_${reactivationModalRequest?.id ?? ""}`);
            setIsReactivationOTPRequesting(false);
            if (result.success) {
              setReactivationOTPSent(true);
            } else {
              setReactivationResult({ success: false, message: result.message || 'Failed to send OTP.' });
            }
          }}
          isProcessing={isReactivationProcessing}
          isRequestingOTP={isReactivationOTPRequesting}
          otpSent={reactivationOTPSent}
          resultMessage={reactivationResult}
        >
          {reactivationAction === 'reject' && !reactivationOTPSent && (
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Rejection Reason (optional)</label>
              <textarea
                value={reactivationRejectionReason}
                onChange={(e) => setReactivationRejectionReason(e.target.value)}
                placeholder="e.g. Shop violated platform policies..."
                rows={2}
                className="w-full px-3 py-2 rounded-lg bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-primary text-sm resize-none"
              />
            </div>
          )}
        </AccountOtpModal>
      )}
    </div>
  );
};

export default AdminDashboard;
