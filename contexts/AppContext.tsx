/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useState, useContext, useCallback, useMemo, ReactNode, useEffect, useRef } from 'react';
import { DocumentOrder, NotificationMessage, OrderStatus, User, UserType, ShopProfile, ShopPricing, PayoutMethod, AppView, ShopPayout, PrintColor, BankDetails, PaymentConfiguration, SupportTicket, TicketCategory, TicketStatus, ReactivationRequest, RefundRequest, EarningsReport } from '../types';

import { Capacitor } from '@capacitor/core';
import { playNewOrderSound, initAudioContext } from '../utils/notificationSound';

// API layer — replaces all Firebase SDK calls
import * as api from '../lib/api';
import {
  authApi, shopApi, orderApi, uploadApi, notificationApi,
  ticketApi, payoutApi, refundApi, bankApi, reactivationApi, adminApi,
  userApi, type AuthTokens,
} from '../lib/queries';

// Pricing utilities — imported from dedicated module for clean HMR
import { calculateBaseFee, calculateOrderPrice, calculateMultiFileOrderPrice, isStudentPassActive, getStudentPassDaysRemaining, getStudentPassExpiryDate } from '../utils/pricing';
export { calculateBaseFee, calculateOrderPrice, calculateMultiFileOrderPrice, isStudentPassActive, getStudentPassDaysRemaining, getStudentPassExpiryDate };

// Push notification registration for native mobile
import { registerPushNotifications, unregisterPushNotifications } from '../utils/pushNotifications';
import { formatMoney } from '../utils/money';

const isDevelopment = import.meta.env.DEV;
const debugLog = (...args: unknown[]) => {
  void isDevelopment;
  void args;
};

// Helper to safely extract error messages from unknown error types
const getErrorMessage = (err: unknown): string => {
  if (err instanceof api.ApiError) return err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'An unexpected error occurred.';
};

interface AppContextType {
  currentUser: User | null;
  isLoadingAuth: boolean;
  pendingProfileCreationType: 'student' | 'shop_owner' | null;
  pendingProfileEmail: string | null;
  pendingProfileName: string | null;
  
  // Compatibility with LoginPage's Google profile creation flow
  pendingFirebaseProfileCreationUser: any | null;
  setPendingFirebaseProfileCreationUser: (user: any | null) => void;

  signInWithGoogle: () => Promise<void>;
  signUpWithEmailPassword: (email: string, password: string, displayName: string) => Promise<{ success: boolean; message?: string }>;
  signInWithEmailAndPassword: (email: string, password: string) => Promise<{ success: boolean; message?: string; errorCode?: string }>;
  completeStudentProfileCreation: (displayName?: string) => Promise<{ success: boolean; message?: string }>;
  completeShopOwnerProfileCreation: (shopDetails: { shopName: string; shopAddress: string; referralCode: string }, displayName?: string) => Promise<{ success: boolean; message?: string; shopId?: string }>;
  checkReturningShopOwner: (email: string) => Promise<{ exists: boolean; hasActiveAccount?: boolean; hasArchivedShop?: boolean; isOwnerOrphaned?: boolean; oldUserId?: string; shop?: ShopProfile }>;

  // Reactivation Requests
  archivedShopForCurrentUser: ShopProfile | null;
  reactivationRequests: ReactivationRequest[];
  submitReactivationRequest: (shopId: string, shopName: string) => Promise<{ success: boolean; message?: string }>;
  resolveReactivationRequest: (requestId: string, action: 'approve' | 'reject', otp: string, rejectionReason?: string) => Promise<{ success: boolean; message?: string }>;
  logoutUser: () => Promise<void>;
  refreshCurrentUser: () => Promise<void>;
  upgradeToStudentPass: () => Promise<{ success: boolean; message?: string }>;
  cancelStudentPass: () => Promise<{ success: boolean; message?: string }>;

  shops: ShopProfile[];
  isLoadingShops: boolean;
  getShopById: (shopId: string) => ShopProfile | undefined;
  registerShop: (shopName: string, shopAddress: string, ownerUserId: string, initialPricing: ShopPricing) => Promise<ShopProfile | null>;
  updateShopSettings: (shopId: string, newSettings: { pricing: ShopPricing; isOpen: boolean; payoutMethods?: PayoutMethod[]; contactPhone?: string; contactPhoneAlt?: string; contactEmail?: string; whatsappNumber?: string }) => Promise<{ success: boolean; message?: string }>;

  orders: DocumentOrder[];
  allOrders: DocumentOrder[]; // Admin: all orders across all shops
  getOrdersForCurrentUser: () => DocumentOrder[];

  notifications: NotificationMessage[];
  addOrder: (orderData: {
    userId: string;
    shopId: string;
    fileInputs: { file: File; fileType: string; pageCount: number; color: PrintColor; copies: number; doubleSided: boolean }[];
    specialInstructions?: string;
  }, onProgress?: (progress: { currentFile: number; totalFiles: number; fileProgress: number; overallProgress: number; fileName: string }) => void) => Promise<{ success: boolean, orderId?: string }>;
  updateOrderStatus: (orderId: string, status: OrderStatus, details?: { shopNotes?: string; paymentAttemptedAt?: string; actingUserType?: UserType }) => Promise<DocumentOrder | undefined>;

  addNotification: (notification: Omit<NotificationMessage, 'id' | 'timestamp' | 'read'>) => void;
  markNotificationAsRead: (notificationId: string) => void;
  /** Clears every unread notification in a single request. */
  markAllNotificationsAsRead: () => void;
  getNotificationsForCurrentUser: () => NotificationMessage[];

  currentView: AppView;
  navigateTo: (view: AppView) => void;
  /** Returns false when there was nothing to go back to. */
  goBack: () => boolean;

  // Admin subscription data
  studentPassHolders: { id: string; name?: string; email?: string; studentPassActivatedAt?: string; studentPassPaymentId?: string }[];

  // Admin payout functions
  payouts: ShopPayout[];
  createPayout: (shopId: string, shopName: string, amount: number, adminNote?: string, otp?: string) => Promise<{ success: boolean; message?: string }>;
  requestPayout: (shopId: string, shopName: string, amount: number, shopOwnerNote?: string) => Promise<{ success: boolean; message?: string }>;
  approvePayout: (payoutId: string, otp: string, adminNote?: string) => Promise<{ success: boolean; message?: string }>;
  /** Admin confirms an IN_TRANSIT payout has landed in the shop's bank account. */
  markPayoutPaid: (payoutId: string, otp: string, adminNote?: string) => Promise<{ success: boolean; message?: string }>;
  rejectPayout: (payoutId: string, otp: string, adminNote?: string) => Promise<{ success: boolean; message?: string }>;
  cancelPayout: (payoutId: string, otp: string) => Promise<{ success: boolean; message?: string }>;
  confirmPayout: (payoutId: string) => Promise<{ success: boolean; message?: string }>;
  disputePayout: (payoutId: string, shopOwnerNote: string) => Promise<{ success: boolean; message?: string }>;

  // Admin shop management
  approveShop: (shopId: string) => Promise<{ success: boolean; message?: string }>;
  rejectShop: (shopId: string, reason?: string) => Promise<{ success: boolean; message?: string }>;
  archiveShop: (shopId: string) => Promise<{ success: boolean; message?: string }>;
  unarchiveShop: (shopId: string) => Promise<{ success: boolean; message?: string }>;
  approvedShops: ShopProfile[]; // Only approved & non-archived shops (for student view)

  // Account Orchestration Flow (OTP protected)
  requestAccountActionOTP: (actionId: string) => Promise<{ success: boolean; message?: string }>;
  executeAccountAction: (action: string, otp: string, targetUid?: string, targetShopId?: string) => Promise<{ success: boolean; message?: string }>;

  // Bank Details (stored in private sub-collection)
  getBankDetails: (shopId: string) => Promise<BankDetails | null>;
  saveBankDetails: (shopId: string, details: BankDetails) => Promise<{ success: boolean; message?: string }>;
  verifyBankDetails: (shopId: string) => Promise<{ success: boolean; message?: string }>;
  logBankAccess: (shopId: string, action: 'VIEW' | 'EDIT' | 'VERIFY') => Promise<void>;

  // Payment Configuration
  getPaymentConfig: (shopId: string) => Promise<PaymentConfiguration | null>;

  // Support Tickets
  tickets: SupportTicket[];
  createTicket: (ticketData: { subject: string; category: TicketCategory; description: string; relatedOrderId?: string; attachmentFiles?: File[] }) => Promise<{ success: boolean; ticketId?: string; message?: string }>;
  /** `attachments` carry an id minted at selection, so a retry is idempotent. */
  addTicketMessage: (ticketId: string, message: string, attachments?: { file: File; uploadId: string }[]) => Promise<{ success: boolean; message?: string }>;
  updateTicketStatus: (ticketId: string, newStatus: TicketStatus, note?: string) => Promise<{ success: boolean; message?: string }>;
  shopInitiateRefund: (ticketId: string, orderId: string, reason: string) => Promise<{ success: boolean; message?: string }>;
  escalateTicketToAdmin: (ticketId: string, reason: string) => Promise<{ success: boolean; message?: string }>;

  // Earnings Reports
  reports: EarningsReport[];

  // Refund Requests
  refundRequests: RefundRequest[];
  createRefundRequest: (orderId: string, reason: string) => Promise<{ success: boolean; message?: string }>;
  respondToRefundRequest: (requestId: string, approved: boolean, shopResponse?: string) => Promise<{ success: boolean; message?: string }>;
  escalateRefundRequest: (requestId: string) => Promise<{ success: boolean; message?: string }>;
  resolveRefundRequest: (requestId: string, action: 'APPROVE' | 'DENY', otp: string, adminNote?: string) => Promise<{ success: boolean; message?: string }>;
  syncRefundHistory: (orderId: string) => Promise<{ success: boolean; count: number; refunds: import('../types').RefundRequest[]; message?: string }>;

  // Pagination Controls
  ordersLimit: number;
  payoutsLimit: number;
  notificationsLimit: number;
  shopsLimit: number;
  loadMoreOrders: () => void;
  /** Re-read orders from the server, e.g. after the server corrects a price. */
  refreshOrders: () => Promise<void>;
  loadMorePayouts: () => void;
  loadMoreNotifications: () => void;
  loadMoreShops: () => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

// Valid status transitions map — prevents invalid state changes
const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  [OrderStatus.PENDING_PAYMENT]: [OrderStatus.PENDING_APPROVAL, OrderStatus.PAYMENT_FAILED, OrderStatus.CANCELLED],
  [OrderStatus.PENDING_APPROVAL]: [OrderStatus.PRINTING, OrderStatus.READY_FOR_PICKUP, OrderStatus.COMPLETED, OrderStatus.CANCELLED],
  [OrderStatus.PRINTING]: [OrderStatus.READY_FOR_PICKUP, OrderStatus.COMPLETED, OrderStatus.CANCELLED],
  [OrderStatus.READY_FOR_PICKUP]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
  [OrderStatus.COMPLETED]: [], // Terminal state
  [OrderStatus.CANCELLED]: [], // Terminal state
  [OrderStatus.REFUNDED]: [], // Terminal state
  [OrderStatus.PAYMENT_FAILED]: [OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED], // Can retry or cancel
};

// ── Polling interval (ms) — replaces Firebase onSnapshot real-time listeners ──
const POLL_INTERVAL = 15_000; // 15 seconds

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUserInternal] = useState<User | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState<boolean>(true);

  // Profile creation flow
  const [pendingProfileCreationType, setPendingProfileCreationType] = useState<'student' | 'shop_owner' | null>(null);
  const [pendingProfileEmail, setPendingProfileEmail] = useState<string | null>(null);
  const [pendingProfileName, setPendingProfileName] = useState<string | null>(null);
  
  const [pendingFirebaseProfileCreationUser, setPendingFirebaseProfileCreationUser] = useState<any | null>(null);
  const [pendingGoogleToken, setPendingGoogleToken] = useState<string | null>(null);

  // Refs to always have the latest values in callbacks (avoids stale closure issues with useMemo)
  const pendingGoogleTokenRef = useRef<string | null>(null);
  const pendingFirebaseProfileCreationUserRef = useRef<any | null>(null);
  useEffect(() => { pendingGoogleTokenRef.current = pendingGoogleToken; }, [pendingGoogleToken]);
  useEffect(() => { pendingFirebaseProfileCreationUserRef.current = pendingFirebaseProfileCreationUser; }, [pendingFirebaseProfileCreationUser]);

  // --- Pagination State ---
  const [ordersLimit, setOrdersLimit] = useState(100);
  const [payoutsLimit, setPayoutsLimit] = useState(100);
  const [notificationsLimit, setNotificationsLimit] = useState(100);
  const [shopsLimit, setShopsLimit] = useState(50);

  const loadMoreOrders = useCallback(() => setOrdersLimit(prev => prev + 100), []);
  const loadMorePayouts = useCallback(() => setPayoutsLimit(prev => prev + 100), []);
  const loadMoreNotifications = useCallback(() => setNotificationsLimit(prev => prev + 50), []);
  const loadMoreShops = useCallback(() => setShopsLimit(prev => prev + 50), []);

  // Stable refs to break dependency cycles

  // Auth state listener (polling since Firebase is removed)
  const addNotificationRef = useRef<(notification: Omit<NotificationMessage, 'id' | 'timestamp' | 'read'>) => void>(() => { });
  const shopsRef = useRef<ShopProfile[]>([]);
  const currentUserRef = useRef<User | null>(null);
  // Held as refs so the push listeners can be attached once per login instead
  // of being torn down and rebuilt every time either callback is recreated.
  const fetchNotificationsRef = useRef<() => Promise<void>>(async () => { });
  const navigateToRef = useRef<(view: AppView) => void>(() => { });

  const [shops, setShops] = useState<ShopProfile[]>([]);
  const [isLoadingShops, setIsLoadingShops] = useState<boolean>(true);
  const [rawOrders, setRawOrders] = useState<DocumentOrder[]>([]);

  /**
   * Order statuses applied locally before the server has confirmed them.
   *
   * This exists so a shop owner tapping "Ready for pickup" sees it happen
   * instantly rather than after a round trip. It is layered over `rawOrders`
   * rather than written into them, so a failure just drops the overlay and the
   * real state reappears with no reconciliation logic.
   *
   * Only order status is ever optimistic. Balances and ledger entries are not,
   * and are deliberately unreachable from here — money on screen always
   * reflects what the server confirmed, because a figure that appears and then
   * vanishes reads as lost money.
   */
  const [optimisticOrderStatus, setOptimisticOrderStatus] = useState<Record<string, OrderStatus>>({});

  const orders = useMemo(
    () => rawOrders.map(order => {
      const pending = optimisticOrderStatus[order.id];
      return pending && pending !== order.status ? { ...order, status: pending } : order;
    }),
    [rawOrders, optimisticOrderStatus]
  );

  const setOrders = setRawOrders;
  const [allOrders, setAllOrders] = useState<DocumentOrder[]>([]); // Admin: all orders
  const [payouts, setPayouts] = useState<ShopPayout[]>([]);
  const [studentPassHolders, setStudentPassHolders] = useState<{ id: string; name?: string; email?: string; studentPassActivatedAt?: string; studentPassPaymentId?: string }[]>([]);
  const [serverNotifications, setServerNotifications] = useState<NotificationMessage[]>([]);
  const [localNotifications, setLocalNotifications] = useState<NotificationMessage[]>([]);
  const [currentView, setCurrentView] = useState<AppView>('landing');
  const viewHistoryRef = useRef<AppView[]>([]);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [reports] = useState<EarningsReport[]>([]);
  const [refundRequests, setRefundRequests] = useState<RefundRequest[]>([]);
  const [archivedShopForCurrentUser, setArchivedShopForCurrentUser] = useState<ShopProfile | null>(null);
  const [reactivationRequests, setReactivationRequests] = useState<ReactivationRequest[]>([]);

  // Merged notifications: server (persistent) + local (session-only toasts)
  const notifications = useMemo(() => {
    const merged = [...localNotifications, ...serverNotifications];
    const scoped = currentUser?.type === UserType.SHOP_OWNER && currentUser.shopId
      ? merged.filter(notification => !notification.targetShopId || notification.targetShopId === currentUser.shopId)
      : merged;
    return scoped.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [localNotifications, serverNotifications, currentUser]);

  const navigateTo = useCallback((view: AppView) => {
    setCurrentView(prev => {
      if (prev !== view) {
        viewHistoryRef.current.push(prev);
        if (viewHistoryRef.current.length > 50) viewHistoryRef.current.shift();
      }
      return view;
    });
    window.scrollTo(0, 0);
  }, []);

  /**
   * Step back one view.
   *
   * Reports whether it actually moved, so the Android back handler can fall
   * through to minimizing the app instead of swallowing the gesture. Silently
   * doing nothing on an empty history is indistinguishable from a frozen app.
   */
  const goBack = useCallback((): boolean => {
    const history = viewHistoryRef.current;
    if (history.length === 0) return false;

    const previousView = history.pop()!;
    setCurrentView(previousView);
    window.scrollTo(0, 0);
    return true;
  }, []);

  const addNotification = useCallback((notificationData: Omit<NotificationMessage, 'id' | 'timestamp' | 'read'>) => {
    const timestamp = new Date().toISOString();

    // Route 'ADMIN' notifications locally
    if (notificationData.targetUserId === 'ADMIN') {
      if (currentUserRef.current?.type === UserType.ADMIN) {
        const localNotif: NotificationMessage = {
          ...notificationData,
          id: `local_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          timestamp,
          read: false,
        };
        setLocalNotifications(prev => [localNotif, ...prev].slice(0, 20));
      }
      return;
    }

    // If recipient is NOT the current user, skip local toast
    if (notificationData.targetUserId && notificationData.targetUserId !== currentUserRef.current?.id) {
      return;
    }

    // For shop owners, keep local toasts scoped to the active shop context
    if (
      currentUserRef.current?.type === UserType.SHOP_OWNER &&
      currentUserRef.current.shopId &&
      notificationData.targetShopId &&
      notificationData.targetShopId !== currentUserRef.current.shopId
    ) {
      return;
    }

    const localNotif: NotificationMessage = {
      ...notificationData,
      id: `local_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      timestamp,
      read: false,
    };
    setLocalNotifications(prev => [localNotif, ...prev].slice(0, 20));
  }, []);

  // Keep refs in sync
  useEffect(() => { addNotificationRef.current = addNotification; }, [addNotification]);
  useEffect(() => { shopsRef.current = shops; }, [shops]);
  useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);
  useEffect(() => { navigateToRef.current = navigateTo; }, [navigateTo]);

  // Clear session-only notifications when the authenticated account changes
  useEffect(() => { setLocalNotifications([]); }, [currentUser?.id, currentUser?.shopId]);

  // Register for push notifications when user logs in (native platforms only)
  useEffect(() => {
    if (!currentUser?.id) return;

    registerPushNotifications({
      onReceived: (title, body) => {
        // The server wrote a Notification row alongside this push. Refetching
        // is what puts it in the bell with a real id, so marking it read
        // actually persists — a local-only copy would silently un-read itself
        // on the next refresh.
        addNotificationRef.current({ message: body || title, type: 'info' });
        void fetchNotificationsRef.current();
      },
      onTapped: () => {
        // Orders and tickets live as sections of the role's dashboard rather
        // than as their own views, so there is nothing finer to deep-link to
        // than the dashboard the user belongs on.
        void fetchNotificationsRef.current();
        const destination =
          currentUserRef.current?.type === UserType.SHOP_OWNER ? 'shopDashboard'
          : currentUserRef.current?.type === UserType.ADMIN ? 'adminDashboard'
          : 'studentDashboard';
        navigateToRef.current(destination);
      },
    });

    return () => { unregisterPushNotifications(); };
  }, [currentUser?.id]);

  // Initialize audio context on first user interaction (required by mobile browsers)
  useEffect(() => {
    const handleInteraction = () => { initAudioContext(); };
    document.addEventListener('click', handleInteraction, { once: true });
    document.addEventListener('touchstart', handleInteraction, { once: true });
    return () => {
      document.removeEventListener('click', handleInteraction);
      document.removeEventListener('touchstart', handleInteraction);
    };
  }, []);

  // ══════════════════════════════════════════════════════════
  // POLLING — replaces Firebase onSnapshot real-time listeners
  // ══════════════════════════════════════════════════════════

  // Track order statuses for paid-order sound detection (shop owners only)
  const knownOrderStatusesRef = useRef<Map<string, string> | null>(null);
  const isFirstOrderLoadRef = useRef(true);

  // Fetch shops
  const fetchShops = useCallback(async () => {
    try {
      const fetchedShops = await shopApi.list({ limit: shopsLimit });
      setShops(fetchedShops);
      setIsLoadingShops(false);
    } catch (err) {
      debugLog('[AppContext] Failed to fetch shops:', err);
      setIsLoadingShops(false);
    }
  }, [shopsLimit]);

  // Fetch orders
  const fetchOrders = useCallback(async () => {
    if (!currentUser) { setOrders([]); setAllOrders([]); return; }

    try {
      let fetchedOrders: DocumentOrder[];
      if (currentUser.type === UserType.ADMIN) {
        fetchedOrders = await orderApi.listAll({ limit: ordersLimit });
        setAllOrders(fetchedOrders);
      } else {
        fetchedOrders = await orderApi.list({ limit: ordersLimit });
      }

      // Paid-order sound for shop owners (web only)
      if (currentUser.type === UserType.SHOP_OWNER && !Capacitor.isNativePlatform()) {
        const currentStatuses = new Map(fetchedOrders.map(o => [o.id, o.status]));
        if (isFirstOrderLoadRef.current) {
          knownOrderStatusesRef.current = currentStatuses;
          isFirstOrderLoadRef.current = false;
        } else if (knownOrderStatusesRef.current) {
          let hasNewPaidOrder = false;
          for (const order of fetchedOrders) {
            if (order.status === OrderStatus.PENDING_APPROVAL) {
              const prevStatus = knownOrderStatusesRef.current.get(order.id);
              if (prevStatus !== OrderStatus.PENDING_APPROVAL) {
                hasNewPaidOrder = true;
              }
            }
          }
          if (hasNewPaidOrder) playNewOrderSound();
          knownOrderStatusesRef.current = currentStatuses;
        }
      }

      setOrders(fetchedOrders);
    } catch (err) {
      debugLog('[AppContext] Failed to fetch orders:', err);
    }
  }, [currentUser, ordersLimit]);

  // Fetch notifications
  const fetchNotifications = useCallback(async () => {
    if (!currentUser) { setServerNotifications([]); return; }
    try {
      const fetched = await notificationApi.list({ limit: notificationsLimit });
      setServerNotifications(fetched);
    } catch (err) {
      debugLog('[AppContext] Failed to fetch notifications:', err);
    }
  }, [currentUser, notificationsLimit]);

  useEffect(() => { fetchNotificationsRef.current = fetchNotifications; }, [fetchNotifications]);

  // Fetch payouts
  const fetchPayouts = useCallback(async () => {
    if (!currentUser) { setPayouts([]); return; }
    if (currentUser.type !== UserType.ADMIN && currentUser.type !== UserType.SHOP_OWNER) {
      setPayouts([]);
      return;
    }
    try {
      const params: { shopId?: string; limit?: number } = { limit: payoutsLimit };
      if (currentUser.type === UserType.SHOP_OWNER && currentUser.shopId) {
        params.shopId = currentUser.shopId;
      }
      const fetched = await payoutApi.list(params);
      setPayouts(fetched);
    } catch (err) {
      debugLog('[AppContext] Failed to fetch payouts:', err);
    }
  }, [currentUser, payoutsLimit]);

  // Fetch tickets
  const fetchTickets = useCallback(async () => {
    if (!currentUser) { setTickets([]); return; }
    try {
      const fetched = await ticketApi.list();
      setTickets(fetched);
    } catch (err) {
      debugLog('[AppContext] Failed to fetch tickets:', err);
    }
  }, [currentUser]);

  // Fetch refund requests
  const fetchRefundRequests = useCallback(async () => {
    if (!currentUser) { setRefundRequests([]); return; }
    try {
      const fetched = await refundApi.list();
      setRefundRequests(fetched);
    } catch (err) {
      debugLog('[AppContext] Failed to fetch refund requests:', err);
    }
  }, [currentUser]);

  // Fetch reactivation requests (admin only)
  const fetchReactivationRequests = useCallback(async () => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      setReactivationRequests([]);
      return;
    }
    try {
      const fetched = await reactivationApi.list();
      setReactivationRequests(fetched);
    } catch (err) {
      debugLog('[AppContext] Failed to fetch reactivation requests:', err);
    }
  }, [currentUser]);

  // Fetch student pass holders (admin only)
  const fetchStudentPassHolders = useCallback(async () => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      setStudentPassHolders([]);
      return;
    }
    try {
      const fetched = await adminApi.getStudentPassHolders();
      setStudentPassHolders(fetched);
    } catch (err) {
      debugLog('[AppContext] Failed to fetch student pass holders:', err);
    }
  }, [currentUser]);

  // Initial data load when user changes
  useEffect(() => {
    if (currentUser) {
      fetchShops();
      fetchOrders();
      fetchNotifications();
      fetchPayouts();
      fetchTickets();
      fetchRefundRequests();
      fetchReactivationRequests();
      fetchStudentPassHolders();
    } else {
      // Clear all data when logged out
      setShops([]);
      setOrders([]);
      setAllOrders([]);
      setPayouts([]);
      setServerNotifications([]);
      setTickets([]);
      setRefundRequests([]);
      setReactivationRequests([]);
      setStudentPassHolders([]);
      setIsLoadingShops(false);
      knownOrderStatusesRef.current = null;
      isFirstOrderLoadRef.current = true;
    }
  }, [currentUser, fetchShops, fetchOrders, fetchNotifications, fetchPayouts, fetchTickets, fetchRefundRequests, fetchReactivationRequests, fetchStudentPassHolders]);

  // Polling interval for data refresh
  useEffect(() => {
    if (!currentUser) return;

    // Order status is what a student actively watches, so it stays on the fast
    // interval. Shop owners get their orders pushed over the real-time channel
    // instead — see useShopLedger.
    const intervalId = setInterval(() => {
      fetchOrders();
      fetchNotifications();
    }, POLL_INTERVAL);

    // Everything that changes rarely. Shop listings in particular were being
    // refetched every 15 seconds by every signed-in user, which alone kept the
    // database from ever idling.
    const slowIntervalId = setInterval(() => {
      fetchShops();
      fetchPayouts();
      fetchTickets();
      fetchRefundRequests();
      fetchReactivationRequests();
    }, POLL_INTERVAL * 4); // 60 seconds

    return () => {
      clearInterval(intervalId);
      clearInterval(slowIntervalId);
    };
  }, [currentUser, fetchOrders, fetchNotifications, fetchShops, fetchPayouts, fetchTickets, fetchRefundRequests, fetchReactivationRequests]);

  // Archived shop detection
  useEffect(() => {
    if (!currentUser || currentUser.type !== UserType.SHOP_OWNER || !currentUser.shopId) {
      setArchivedShopForCurrentUser(null);
      return;
    }
    const shop = shops.find(s => s.id === currentUser.shopId);
    if (shop && shop.isArchived) {
      setArchivedShopForCurrentUser(shop);
    } else {
      setArchivedShopForCurrentUser(null);
    }
  }, [currentUser, shops]);

  // ══════════════════════════════════════════════════════════
  // AUTH — replaces Firebase Auth (onAuthStateChanged, signInWithPopup, etc.)
  // ══════════════════════════════════════════════════════════

  const handleAuthSuccessRef = useRef<(authResult: AuthTokens) => void>(() => {});

  const handleAuthSuccess = useCallback((authResult: AuthTokens) => {
    api.setTokens(authResult.tokens.accessToken, authResult.tokens.refreshToken);
    setCurrentUserInternal(authResult.user);
    setPendingProfileCreationType(null);
    setPendingProfileEmail(null);
    setPendingProfileName(null);
    setPendingFirebaseProfileCreationUser(null);
    setPendingGoogleToken(null);
  }, []);

  useEffect(() => {
    handleAuthSuccessRef.current = handleAuthSuccess;
  }, [handleAuthSuccess]);

  // On app load: try to restore session from stored refresh token
  // Also handles Google OAuth redirect callback (must run before session restore)
  const startupRanRef = useRef(false);
  useEffect(() => {
    // Guard against React strict mode double-execution
    if (startupRanRef.current) return;
    startupRanRef.current = true;

    const handleStartup = async () => {
      setIsLoadingAuth(true);

      // ── Step 1: Check for Google OAuth redirect callback ──
      const hash = window.location.hash;
      if (hash.includes('access_token=')) {
        const params = new URLSearchParams(hash.substring(1));
        const accessToken = params.get('access_token');
        
        if (accessToken) {
          // Clear hash from URL without reloading
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
          
          try {
            const response = await authApi.googleAuth({ idToken: accessToken });
            
            if ('isNewUser' in response) {
              setPendingGoogleToken(accessToken);
              setPendingProfileEmail(response.email);
              setPendingProfileName(response.name);
              setPendingProfileCreationType(null);
              setPendingFirebaseProfileCreationUser({ 
                email: response.email, 
                displayName: response.name, 
                providerData: [{ providerId: 'google.com' }] 
              });
            } else {
              // Existing user — log them in directly
              const authResult = response as AuthTokens;
              api.setTokens(authResult.tokens.accessToken, authResult.tokens.refreshToken);
              setCurrentUserInternal(authResult.user);
            }
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error('[AppContext] Google OAuth redirect failed:', errorMessage);
            addNotificationRef.current({ message: `Google Sign-In failed: ${errorMessage}`, type: 'error' });
          } finally {
            setIsLoadingAuth(false);
          }
          return; // Don't do session restore — we just handled OAuth
        }
      }

      // ── Step 2: Normal session restore ──
      const storedRefresh = api.loadRefreshToken();
      if (!storedRefresh) {
        setIsLoadingAuth(false);
        return;
      }

      try {
        // Try to refresh the access token
        const result = await authApi.refresh(storedRefresh);
        api.setTokens(result.tokens.accessToken, result.tokens.refreshToken);

        // Fetch user profile
        const user = await authApi.me();
        setCurrentUserInternal(user);
      } catch (err) {
        debugLog('[AppContext] Session restore failed:', err);
        api.clearTokens();
      } finally {
        setIsLoadingAuth(false);
      }
    };

    handleStartup();
  }, []);




  const signInWithGoogle = async (): Promise<void> => {
    setIsLoadingAuth(true);
    const isNative = Capacitor.isNativePlatform();

    try {
      let idToken: string;

      if (isNative) {
        // Native Android/iOS: use native Google Sign-In via Credential Manager
        const { SocialLogin } = await import('@capgo/capacitor-social-login');
        await SocialLogin.initialize({
          google: {
            webClientId: '283831997162-p8afki1sjtfa9srdvr6infpf06gofmk5.apps.googleusercontent.com',
          },
        });
        const result = await SocialLogin.login({
          provider: 'google',
          options: { scopes: ['email', 'profile'] },
        });
        const loginResponse = result?.result;
        if (!loginResponse || loginResponse.responseType !== 'online' || !loginResponse.idToken) {
          // Name what came back. "No result" is true of a dismissed sheet, a
          // credential that was not a Google account, and an offline-mode
          // response that carries a server auth code instead of an id token —
          // three different problems that need three different fixes.
          throw new Error(
            `Native Google Sign-In returned no id token (responseType: ${
              loginResponse?.responseType ?? 'none'
            }).`
          );
        }
        idToken = loginResponse.idToken;
      } else {
        // Web: use Google OAuth2 popup via initTokenClient
        idToken = await new Promise<string>((resolve, reject) => {
          const script = document.getElementById('google-gsi-script') || document.createElement('script');
          if (!document.getElementById('google-gsi-script')) {
            script.id = 'google-gsi-script';
            (script as HTMLScriptElement).src = 'https://accounts.google.com/gsi/client';
            (script as HTMLScriptElement).async = true;
            document.head.appendChild(script);
          }

          const initGoogle = () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const google = (window as any).google;
            if (!google?.accounts?.oauth2) {
              reject(new Error('Google OAuth2 API not loaded'));
              return;
            }
            
            try {
              const client = google.accounts.oauth2.initTokenClient({
                client_id: '283831997162-p8afki1sjtfa9srdvr6infpf06gofmk5.apps.googleusercontent.com',
                scope: 'email profile openid',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                callback: (response: any) => {
                  if (response.access_token) {
                    resolve(response.access_token);
                  } else {
                    reject(new Error('Google sign-in cancelled or failed'));
                  }
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                error_callback: (error: any) => {
                  reject(new Error(error.message || 'Google sign-in popup failed'));
                }
              });
              client.requestAccessToken();
            } catch (err) {
              reject(err);
            }
          };

          // The script is preloaded in index.html, so this is the normal path:
          // requestAccessToken() runs synchronously inside the click, which is
          // the only way Firefox and Safari will allow the popup.
          if ((window as any).google) {
            initGoogle();
          } else {
            // Clicked before the preload finished. Opening the popup from the
            // load event would lose the user-gesture context and be blocked, so
            // say so plainly rather than surfacing "popup blocked" — which
            // sends people into their browser settings for no reason.
            script.addEventListener('load', () => reject(
              new Error('Google Sign-In just finished loading. Please tap the button again.')
            ), { once: true });
            script.addEventListener('error', () => reject(new Error('Failed to load Google Identity Services')));
          }
        });
      }

      // Send access_token to our backend
      const response = await authApi.googleAuth({ idToken });
      
      if ('isNewUser' in response) {
        setPendingGoogleToken(idToken);
        setPendingProfileEmail(response.email);
        setPendingProfileName(response.name);
        setPendingProfileCreationType(null);
        // Trigger LoginPage's role selection flow
        setPendingFirebaseProfileCreationUser({ 
          email: response.email, 
          displayName: response.name, 
          providerData: [{ providerId: 'google.com' }] 
        });
        setIsLoadingAuth(false);
        return;
      }

      handleAuthSuccess(response as AuthTokens);

    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const lower = errorMessage.toLowerCase();

      // Always on the console, whatever we decide to show. On a device this is
      // the only way to read the native exception, via chrome://inspect.
      console.error('[auth] Google Sign-In failed:', err);

      // Only the web popup is ever dismissed silently, and only because we
      // author those rejection messages ourselves a few lines above.
      //
      // Native errors are always surfaced. Android's Credential Manager
      // reports configuration problems, missing credentials and internal
      // failures through exceptions whose text also contains "cancelled", so
      // matching on that word swallowed every real fault and dropped the user
      // back on the sign-in screen with nothing to act on.
      const isDismissedPopup =
        !isNative && (lower.includes('cancel') || lower.includes('popup-closed'));

      if (!isDismissedPopup) {
        addNotification({ message: `Google Sign-In failed: ${errorMessage}`, type: 'error' });
      }
      setCurrentUserInternal(null);
    } finally {
      setIsLoadingAuth(false);
    }
  };

  const signUpWithEmailPassword = async (email: string, _password: string, displayName: string): Promise<{ success: boolean; message?: string }> => {
    setIsLoadingAuth(true);
    try {
      // Store the pending state — registration happens when profile type is chosen
      setPendingProfileEmail(email);
      setPendingProfileName(displayName);
      // Don't register yet — wait for completeStudentProfileCreation or completeShopOwnerProfileCreation
      // which will call authApi.register with the correct type
      setPendingFirebaseProfileCreationUser({ 
        email, 
        displayName, 
        providerData: [{ providerId: 'password' }], 
        _tempPassword: _password 
      });
      setIsLoadingAuth(false);
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Registration failed: ${message}`, type: 'error' });
      setIsLoadingAuth(false);
      return { success: false, message };
    }
  };

  const signInWithEmailAndPasswordInternal = async (email: string, password: string): Promise<{ success: boolean; message?: string; errorCode?: string }> => {
    setIsLoadingAuth(true);
    try {
      const tokens = await authApi.login(email, password);
      handleAuthSuccess(tokens);
      setIsLoadingAuth(false);
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message, type: 'error' });
      setCurrentUserInternal(null);
      setIsLoadingAuth(false);
      return { success: false, message, errorCode: err instanceof api.ApiError ? err.code : undefined };
    }
  };

  const completeStudentProfileCreation = async (displayName?: string): Promise<{ success: boolean; message?: string }> => {
    setIsLoadingAuth(true);
    try {
      const googleToken = pendingGoogleTokenRef.current;
      const pendingUser = pendingFirebaseProfileCreationUserRef.current;

      if (googleToken) {
        const response = await authApi.googleAuth({ idToken: googleToken, userType: 'STUDENT' });
        if ('isNewUser' in response) throw new Error('Unexpected state');
        handleAuthSuccess(response as AuthTokens);
        setPendingGoogleToken(null);
        setPendingFirebaseProfileCreationUser(null);
        return { success: true };
      }

      const email = pendingProfileEmail;
      const name = displayName || pendingProfileName || 'Student';
      if (!email) throw new Error('No pending registration email');

      // Call the backend register endpoint with STUDENT type
      const tokens = await authApi.register({
        email,
        password: pendingUser?._tempPassword || '',
        name,
        type: 'STUDENT',
      });

      handleAuthSuccess(tokens);
      addNotification({ message: `Welcome, ${name}! Registration successful.`, type: 'success', targetUserId: tokens.user.id });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Registration failed: ${message}`, type: 'error' });
      setPendingFirebaseProfileCreationUser(null);
      return { success: false, message };
    } finally {
      setIsLoadingAuth(false);
    }
  };

  const registerShop = useCallback(async (_shopName: string, _shopAddress: string, _ownerUserId: string, _initialPricing: ShopPricing): Promise<ShopProfile | null> => {
    // Shop registration is handled by the backend as part of auth/register
    // This function exists for interface compatibility
    return null;
  }, []);

  const checkReturningShopOwner = useCallback(async (email: string) => {
    try {
      return await adminApi.checkReturningShopOwner(email);
    } catch (err) {
      debugLog("Error checking returning shopowner:", err);
      return { exists: false };
    }
  }, []);

  const completeShopOwnerProfileCreation = async (
    shopDetails: { shopName: string; shopAddress: string; referralCode: string },
    displayName?: string
  ): Promise<{ success: boolean; message?: string; shopId?: string }> => {
    setIsLoadingAuth(true);
    try {
      const googleToken = pendingGoogleTokenRef.current;
      const pendingUser = pendingFirebaseProfileCreationUserRef.current;

      if (googleToken) {
        const response = await authApi.googleAuth({ 
          idToken: googleToken, 
          userType: 'SHOP_OWNER', 
          shopName: shopDetails.shopName, 
          shopAddress: shopDetails.shopAddress,
          referralCode: shopDetails.referralCode
        });
        if ('isNewUser' in response) throw new Error('Unexpected state');
        const tokens = response as AuthTokens;
        handleAuthSuccess(tokens);
        setPendingGoogleToken(null);
        setPendingFirebaseProfileCreationUser(null);
        
        return { 
          success: true, 
          shopId: tokens.user.shopId 
        };
      }

      const trimmedShopName = shopDetails.shopName.trim();
      if (!trimmedShopName) {
        setIsLoadingAuth(false);
        const message = "Shop name cannot be empty.";
        addNotification({ message, type: 'error' });
        return { success: false, message };
      }

      const email = pendingProfileEmail;
      const name = displayName || pendingProfileName || 'Shop Owner';
      if (!email) throw new Error('No pending registration email');

      const registerPayload = {
        email,
        password: pendingUser?._tempPassword || '',
        name,
        type: 'SHOP_OWNER' as const,
        shopName: trimmedShopName,
        shopAddress: shopDetails.shopAddress,
        referralCode: shopDetails.referralCode,
      };
      console.log('[DEBUG] Register payload:', { ...registerPayload, password: registerPayload.password ? `[${registerPayload.password.length} chars]` : 'EMPTY' });
      console.log('[DEBUG] pendingUser ref:', pendingUser);
      console.log('[DEBUG] pendingGoogleToken ref:', googleToken);

      const tokens = await authApi.register(registerPayload);

      handleAuthSuccess(tokens);
      addNotification({
        message: `Welcome, ${name}! Shop '${trimmedShopName}' registered and is pending admin approval.`,
        type: 'success',
        targetUserId: tokens.user.id
      });
      return { success: true, shopId: tokens.user.shopId };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Shop registration failed: ${message}`, type: 'error' });
      return { success: false, message };
    } finally {
      setIsLoadingAuth(false);
    }
  };

  const logoutUser = async (): Promise<void> => {
    setIsLoadingAuth(true);
    try {
      await authApi.logout();
    } catch (err) {
      debugLog('[AppContext] Logout error:', err);
    } finally {
      api.clearTokens();
      setCurrentUserInternal(null);
      setIsLoadingAuth(false);
    }
  };

  // Re-fetch the current user profile from the backend to pick up changes
  // (e.g., shop approval, rejection, etc.) without requiring logout/login
  const refreshCurrentUser = async (): Promise<void> => {
    try {
      const user = await authApi.me();
      setCurrentUserInternal(user);
    } catch (err) {
      debugLog('[AppContext] refreshCurrentUser failed:', err);
    }
  };

  const upgradeToStudentPass = async (): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser) return { success: false, message: "Not logged in" };
    if (currentUser.type !== UserType.STUDENT) {
      return { success: false, message: "Only students can upgrade to Student Pass." };
    }
    // The server activated the pass during payment verification; re-read the
    // profile so the client reflects what was actually persisted. Setting the
    // flag locally without this was why a bought pass disappeared on refresh —
    // and why pricing kept charging the base fee, since the server never knew.
    try {
      const me = await userApi.getProfile();
      setCurrentUserInternal(prev => prev ? { ...prev, ...me } : null);
      if (!me.hasStudentPass) {
        return { success: false, message: 'Payment went through but the pass is not active yet. Refresh in a moment, or contact support if it persists.' };
      }
      addNotification({ message: "Congratulations! You have upgraded to Student Pass.", type: 'success', targetUserId: currentUser.id });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  };

  const cancelStudentPass = async (): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser) return { success: false, message: "Not logged in" };
    if (currentUser.type !== UserType.STUDENT) {
      return { success: false, message: "Only students can cancel Student Pass." };
    }
    try {
      await userApi.updateProfile({ });
      setCurrentUserInternal(prev => prev ? { ...prev, hasStudentPass: false } : null);
      addNotification({ message: "Your Student Pass has been cancelled.", type: 'info', targetUserId: currentUser.id });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  };

  const getShopById = useCallback((shopId: string) => shops.find(s => s.id === shopId), [shops]);

  const updateShopSettings = useCallback(async (shopId: string, newSettings: { pricing: ShopPricing; isOpen: boolean; payoutMethods?: PayoutMethod[]; contactPhone?: string; contactPhoneAlt?: string; contactEmail?: string; whatsappNumber?: string }) => {
    try {
      await shopApi.update(shopId, newSettings);
      const shopFromState = shops.find(s => s.id === shopId);
      addNotification({
        message: `Settings updated for shop ${shopFromState?.name || shopId}.`,
        type: 'success',
        targetShopId: shopId,
        ...(shopFromState?.ownerUserId && { targetUserId: shopFromState.ownerUserId })
      });
      // Refresh shops to pick up changes
      fetchShops();
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to update shop settings: ${message}`, type: 'error', targetShopId: shopId });
      return { success: false, message };
    }
  }, [addNotification, shops, fetchShops]);

  // ══════════════════════════════════════════════════════════
  // ORDERS — create + update status
  // ══════════════════════════════════════════════════════════

  const addOrder = useCallback(async (
    orderData: {
      userId: string;
      shopId: string;
      fileInputs: { file: File; fileType: string; pageCount: number; color: PrintColor; copies: number; doubleSided: boolean }[];
      specialInstructions?: string;
    },
    onProgress?: (progress: { currentFile: number; totalFiles: number; fileProgress: number; overallProgress: number; fileName: string }) => void
  ): Promise<{ success: boolean, orderId?: string }> => {
    const { userId, shopId, fileInputs, specialInstructions } = orderData;

    if (!fileInputs || fileInputs.length === 0) {
      addNotification({ message: "No files selected.", type: 'error', targetUserId: userId });
      return { success: false };
    }

    const targetShop = getShopById(shopId);
    if (!targetShop) {
      addNotification({ message: "Error placing order: Selected shop not found.", type: 'error', targetUserId: userId });
      return { success: false };
    }
    if (!targetShop.isOpen) {
      addNotification({ message: `Error placing order: Shop '${targetShop.name}' is currently closed.`, type: 'error', targetUserId: userId });
      return { success: false };
    }

    // 1. Create order on backend
    let orderId = '';
    let verifiedPrice: DocumentOrder['priceDetails'];
    let orderFiles: { id: string }[] = [];
    try {
      const draftResult = await orderApi.create({
        shopId,
        specialInstructions,
        files: fileInputs.map(fi => ({
          fileName: fi.file.name,
          fileType: fi.fileType,
          fileSizeBytes: fi.file.size,
          pageCount: fi.pageCount,
          color: fi.color,
          copies: fi.copies,
          doubleSided: fi.doubleSided,
        })),
      });
      orderId = draftResult.orderId;
      verifiedPrice = draftResult.verifiedPrice;
      orderFiles = draftResult.files;
    } catch (err: unknown) {
      addNotification({ message: `Failed to initialize order: ${getErrorMessage(err)}`, type: 'error', targetUserId: userId });
      return { success: false };
    }

    const totalFiles = fileInputs.length;

    addNotification({ message: `Uploading ${totalFiles} file(s)...`, type: 'info', targetUserId: userId });

    // 2. Upload files via REST API
    const CONCURRENCY = 3;
    try {
      for (let batchStart = 0; batchStart < totalFiles; batchStart += CONCURRENCY) {
        const batchEnd = Math.min(batchStart + CONCURRENCY, totalFiles);
        const batch = fileInputs.slice(batchStart, batchEnd).map(async (fi, i) => {
          const index = batchStart + i;
          const formData = new FormData();
          formData.append('file', fi.file);
          formData.append('metadata', JSON.stringify({ orderId, fileIndex: String(index) }));
          if (orderFiles && orderFiles[index]) {
            formData.append('uploadId', orderFiles[index].id);
          }
          await api.upload(`/uploads/single`, formData);
          onProgress?.({
            currentFile: index + 1,
            totalFiles,
            fileProgress: 100,
            overallProgress: Math.round(((index + 1) / totalFiles) * 100),
            fileName: fi.file.name,
          });
        });
        await Promise.all(batch);
      }
    } catch (uploadError: unknown) {
      addNotification({
        message: `Upload failed: ${getErrorMessage(uploadError)}. Your draft order will expire automatically if payment is not completed.`,
        type: 'error',
        targetUserId: userId
      });
      return { success: false };
    }

    // 3. Success notification
    const fileLabel = fileInputs.length === 1 ? fileInputs[0].file.name : `${fileInputs.length} files`;
    addNotification({ message: `Order #${orderId.slice(-6)} for ${fileLabel} (${formatMoney(verifiedPrice.totalPrice)}) placed at ${targetShop.name}. Proceed to payment.`, orderId, type: 'info', targetUserId: userId });

    // Refresh orders
    fetchOrders();
    return { success: true, orderId };
  }, [addNotification, getShopById, fetchOrders]);

  const updateOrderStatus = useCallback(async (orderId: string, status: OrderStatus, details?: { shopNotes?: string; paymentAttemptedAt?: string; actingUserType?: UserType }): Promise<DocumentOrder | undefined> => {
    try {
      // Find current order from local state for validation
      const currentOrderData = orders.find(o => o.id === orderId);
      if (!currentOrderData) {
        throw new Error(`Order #${orderId.slice(-6)} not found.`);
      }

      // Validate transition client-side
      if (status !== currentOrderData.status) {
        const allowedTransitions = VALID_STATUS_TRANSITIONS[currentOrderData.status];
        if (!allowedTransitions || !allowedTransitions.includes(status)) {
          throw new Error(
            `Invalid status transition: cannot move from "${currentOrderData.status.replace(/_/g, ' ')}" to "${status.replace(/_/g, ' ')}".`
          );
        }
      }

      // Show the new status straight away. The shop owner is standing at the
      // counter with a customer; waiting on a round trip to see their own tap
      // register makes the app feel broken.
      setOptimisticOrderStatus(prev => ({ ...prev, [orderId]: status }));

      let updatedOrder: DocumentOrder | undefined;
      try {
        updatedOrder = await orderApi.updateStatus(orderId, status, {
          shopNotes: details?.shopNotes,
          paymentAttemptedAt: details?.paymentAttemptedAt,
        });
      } catch (err) {
        // Roll back to the real state and let the caller surface the error.
        setOptimisticOrderStatus(prev => {
          const next = { ...prev };
          delete next[orderId];
          return next;
        });
        throw err;
      }

      // Send local notifications
      if (updatedOrder) {
        const targetShop = getShopById(updatedOrder.shopId);
        const studentUserName = updatedOrder.userName || 'Student';

        let studentMessage = `Order #${orderId.slice(-6)} (${updatedOrder.fileName}) at ${targetShop?.name || 'shop'} is now ${status.replace(/_/g, ' ').toLowerCase()}.`;
        const shopMessage = `Order #${orderId.slice(-6)} (${updatedOrder.fileName}) by ${studentUserName} is now ${status.replace(/_/g, ' ').toLowerCase()}.`;
        let type: NotificationMessage['type'] = 'info';

        if (status === OrderStatus.PENDING_APPROVAL) {
          type = 'success';
          addNotification({ message: shopMessage, orderId, type, targetShopId: updatedOrder.shopId });
          addNotification({ message: studentMessage, orderId, type, targetUserId: updatedOrder.userId });
        } else if (status === OrderStatus.PAYMENT_FAILED) {
          type = 'error';
          addNotification({ message: shopMessage, orderId, type, targetShopId: updatedOrder.shopId });
          addNotification({ message: studentMessage, orderId, type, targetUserId: updatedOrder.userId });
        } else if (details?.actingUserType === UserType.SHOP_OWNER) {
          if (status === OrderStatus.READY_FOR_PICKUP) {
            studentMessage += ` Pickup code: ${updatedOrder.pickupCode}`;
            type = 'success';
          } else if (status === OrderStatus.CANCELLED) {
            studentMessage = `Order #${orderId.slice(-6)} has been cancelled by ${targetShop?.name || 'the shop'}.`;
            type = 'warning';
            if (details?.shopNotes) studentMessage += ` Reason: ${details.shopNotes}`;
          }
          addNotification({ message: studentMessage, orderId, type, targetUserId: updatedOrder.userId });
        }
      }

      // Refresh from the server, then drop the overlay so the confirmed status
      // takes over. Clearing it before the refetch lands would flash the old
      // status back for a frame.
      await fetchOrders();
      setOptimisticOrderStatus(prev => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });

      return updatedOrder;
    } catch (err: unknown) {
      addNotification({ message: `Failed to update order status: ${getErrorMessage(err)}`, type: 'error' });
      return undefined;
    }
  }, [orders, addNotification, getShopById, fetchOrders]);

  // ══════════════════════════════════════════════════════════
  // PAYOUTS
  // ══════════════════════════════════════════════════════════

  const createPayout = useCallback(async (shopId: string, shopName: string, amount: number, adminNote?: string, otp?: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) return { success: false, message: "Only admins can manually create payouts." };
    try {
      if (!otp) throw new Error("OTP is required to process manual payouts.");
      await payoutApi.createManual({ shopId, shopName, amount, adminNote, otp });
      addNotification({ message: `Manual payout processed for ${shopName}.`, type: 'success', targetShopId: shopId });
      fetchPayouts();
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to create payout: ${message}`, type: 'error', targetShopId: shopId });
      return { success: false, message };
    }
  }, [currentUser, addNotification, fetchPayouts]);

  const approvePayout = useCallback(async (payoutId: string, otp: string, adminNote?: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) return { success: false, message: "Only admins can approve payouts." };
    try {
      await payoutApi.approve(payoutId, otp, adminNote);
      addNotification({ message: `Payout marked as paid.`, type: 'success' });
      fetchPayouts();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [currentUser, addNotification, fetchPayouts]);

  const markPayoutPaid = useCallback(async (payoutId: string, otp: string, adminNote?: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) return { success: false, message: "Only admins can mark payouts as paid." };
    try {
      await payoutApi.markPaid(payoutId, otp, adminNote);
      addNotification({ message: `Payout marked as landed in the shop's account.`, type: 'success' });
      fetchPayouts();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [currentUser, addNotification, fetchPayouts]);

  const rejectPayout = useCallback(async (payoutId: string, otp: string, adminNote?: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) return { success: false, message: "Only admins can reject payouts." };
    try {
      await payoutApi.reject(payoutId, otp, adminNote);
      addNotification({ message: `Payout request rejected and reversed safely.`, type: 'success' });
      fetchPayouts();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [currentUser, addNotification, fetchPayouts]);

  const cancelPayout = useCallback(async (payoutId: string, otp: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) return { success: false, message: "Only admins can cancel payouts." };
    try {
      await payoutApi.cancel(payoutId, otp);
      addNotification({ message: `Payout cancelled and reversed safely.`, type: 'success' });
      fetchPayouts();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [currentUser, addNotification, fetchPayouts]);

  const requestPayout = useCallback(async (shopId: string, _shopName: string, amount: number, shopOwnerNote?: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.SHOP_OWNER) return { success: false, message: "Only shop owners can request payouts." };
    if (amount <= 0) return { success: false, message: "Amount must be greater than 0." };
    try {
      addNotification({ message: `Submitting payout request...`, type: 'info' });
      await payoutApi.request({ shopId, amount, shopOwnerNote });
      addNotification({ message: `Payout request of ${formatMoney(amount)} submitted. Admin will review and process it.`, type: 'success', targetShopId: shopId });
      fetchPayouts();
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to request payout: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification, fetchPayouts]);

  const confirmPayout = useCallback(async (payoutId: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.SHOP_OWNER) return { success: false, message: "Only shop owners can confirm payouts." };
    try {
      await payoutApi.confirm(payoutId);
      addNotification({ message: `Payout confirmed! Thank you.`, type: 'success', targetUserId: currentUser.id });
      fetchPayouts();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [currentUser, addNotification, fetchPayouts]);

  const disputePayout = useCallback(async (payoutId: string, shopOwnerNote: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.SHOP_OWNER) return { success: false, message: "Only shop owners can dispute payouts." };
    if (!shopOwnerNote?.trim()) return { success: false, message: "Dispute note cannot be empty." };
    try {
      await payoutApi.dispute(payoutId, shopOwnerNote);
      addNotification({ message: `Payout disputed. Admin has been notified.`, type: 'warning', targetUserId: currentUser.id });
      fetchPayouts();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [currentUser, addNotification, fetchPayouts]);

  // ══════════════════════════════════════════════════════════
  // NOTIFICATIONS
  // ══════════════════════════════════════════════════════════

  const markNotificationAsRead = useCallback((notificationId: string) => {
    if (notificationId.startsWith('local_')) {
      setLocalNotifications(prev => prev.map(n => (n.id === notificationId ? { ...n, read: true } : n)));
    } else {
      notificationApi.markAsRead(notificationId).catch(err => {
        debugLog("[AppContext] Failed to mark notification as read:", err);
      });
      // Optimistic update
      setServerNotifications(prev => prev.map(n => (n.id === notificationId ? { ...n, read: true } : n)));
    }
  }, []);

  /**
   * Mark everything read in one request.
   *
   * The bell used to do this by looping markNotificationAsRead over every
   * unread row. That was invisible while the server never created a single
   * notification; now that it does, a user coming back to fifty of them would
   * have fired fifty PATCHes and run straight into the rate limiter.
   */
  const markAllNotificationsAsRead = useCallback(() => {
    setLocalNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setServerNotifications(prev => prev.map(n => ({ ...n, read: true })));

    notificationApi.markAllAsRead().catch(err => {
      debugLog('[AppContext] Failed to mark all notifications as read:', err);
      // Put the optimistic update back — leaving the bell clear while the
      // server still has them unread means they reappear on next refresh with
      // no explanation.
      void fetchNotifications();
    });
  }, [fetchNotifications]);

  const getNotificationsForCurrentUser = useCallback(() => notifications, [notifications]);
  const getOrdersForCurrentUser = useCallback(() => orders, [orders]);

  // ══════════════════════════════════════════════════════════
  // ADMIN SHOP MANAGEMENT
  // ══════════════════════════════════════════════════════════

  const approveShop = useCallback(async (shopId: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) return { success: false, message: "Only admins can approve shops." };
    try {
      await shopApi.approve(shopId);
      addNotification({ message: `Shop approved successfully.`, type: 'success' });
      fetchShops();
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to approve shop: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification, fetchShops]);

  const rejectShop = useCallback(async (shopId: string, reason?: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) return { success: false, message: "Only admins can reject shops." };
    try {
      await shopApi.reject(shopId, reason);
      addNotification({ message: `Shop rejected and removed.`, type: 'info' });
      fetchShops();
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to reject shop: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification, fetchShops]);

  const archiveShop = useCallback(async (shopId: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) return { success: false, message: "Only admins can archive shops." };
    try {
      await shopApi.archive(shopId);
      const shop = shops.find(s => s.id === shopId);
      addNotification({ message: `Shop "${shop?.name || shopId}" has been archived.`, type: 'info' });
      fetchShops();
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to archive shop: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification, shops, fetchShops]);

  const unarchiveShop = useCallback(async (shopId: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) return { success: false, message: "Only admins can unarchive shops." };
    try {
      await shopApi.unarchive(shopId);
      const shop = shops.find(s => s.id === shopId);
      addNotification({ message: `Shop "${shop?.name || shopId}" has been unarchived.`, type: 'success' });
      fetchShops();
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to unarchive shop: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification, shops, fetchShops]);

  // ══════════════════════════════════════════════════════════
  // TICKETS
  // ══════════════════════════════════════════════════════════

  const createTicket = useCallback(async (ticketData: { subject: string; category: TicketCategory; description: string; relatedOrderId?: string; attachmentFiles?: File[] }): Promise<{ success: boolean; ticketId?: string; message?: string }> => {
    if (!currentUser) return { success: false, message: 'Not logged in' };
    if (currentUser.type === UserType.SHOP_OWNER && !currentUser.shopId) {
      return { success: false, message: 'Shop data is still loading.' };
    }
    try {
      const result = await ticketApi.create({
        subject: ticketData.subject.trim(),
        category: ticketData.category,
        description: ticketData.description.trim(),
        relatedOrderId: ticketData.relatedOrderId,
      });

      // Upload attachments if any.
      //
      // A failed attachment must not lose the ticket: it has already been
      // created, and the description is the part support actually needs. The
      // student is told which files did not make it so they can add them to the
      // conversation rather than starting over.
      const failedAttachments: string[] = [];

      if (ticketData.attachmentFiles && ticketData.attachmentFiles.length > 0) {
        for (const [index, file] of ticketData.attachmentFiles.slice(0, 3).entries()) {
          if (file.size > 5 * 1024 * 1024) {
            failedAttachments.push(`${file.name} (over 5MB)`);
            continue;
          }
          try {
            // Derived from the ticket and position rather than random, so a
            // retry of this same upload reuses the server's idempotency key
            // instead of storing a duplicate.
            await uploadApi.uploadSingle(file, `ticket_${result.ticketId}_${index}`, { ticketId: result.ticketId });
          } catch {
            failedAttachments.push(file.name);
          }
        }
      }

      if (failedAttachments.length > 0) {
        addNotification({
          message: `Ticket created, but these files could not be attached: ${failedAttachments.join(', ')}. You can add them in the ticket.`,
          type: 'warning',
          targetUserId: currentUser.id,
        });
      }

      addNotification({ message: `Ticket "${ticketData.subject}" submitted.`, type: 'success', targetUserId: currentUser.id });
      fetchTickets();
      return { success: true, ticketId: result.ticketId };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to create ticket: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification, fetchTickets]);

  const addTicketMessage = useCallback(async (
    ticketId: string,
    message: string,
    attachments?: { file: File; uploadId: string }[],
  ): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser) return { success: false, message: 'Not logged in' };
    try {
      const posted = await ticketApi.addMessage(ticketId, message);

      // Uploaded after the message so a rejected file cannot swallow the reply
      // itself — the text is the part the other party is waiting on. Each
      // carries the id minted when it was picked, so retrying a failed send
      // reuses the server's idempotency key rather than storing a second copy.
      const failed: string[] = [];
      for (const { file, uploadId } of attachments ?? []) {
        try {
          // messageId is what puts the file inside the conversation rather
          // than in a separate pile beside it.
          await uploadApi.uploadSingle(file, uploadId, { ticketId, messageId: posted?.message?.id });
        } catch {
          failed.push(file.name);
        }
      }

      // Awaited, unlike before: the caller clears its composer on success, and
      // clearing before the refetch lands makes a just-sent attachment vanish
      // until something else triggers a reload.
      await fetchTickets();

      if (failed.length > 0) {
        addNotification({
          message: `Reply sent, but these files could not be attached: ${failed.join(', ')}.`,
          type: 'warning',
        });
      }

      return { success: true };
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      addNotification({ message: `Failed to send reply: ${errorMessage}`, type: 'error' });
      return { success: false, message: errorMessage };
    }
  }, [currentUser, addNotification, fetchTickets]);

  const updateTicketStatus = useCallback(async (ticketId: string, newStatus: TicketStatus, note?: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser) return { success: false, message: 'Not logged in' };
    try {
      await ticketApi.updateStatus(ticketId, newStatus, note);
      addNotification({ message: `Ticket status changed to ${newStatus.replace(/_/g, ' ')}.`, type: 'info' });
      fetchTickets();
      return { success: true };
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      addNotification({ message: `Failed to update ticket: ${errorMessage}`, type: 'error' });
      return { success: false, message: errorMessage };
    }
  }, [currentUser, addNotification, fetchTickets]);

  const shopInitiateRefund = useCallback(async (_ticketId: string, orderId: string, reason: string): Promise<{ success: boolean; message?: string }> => {
    try {
      if (!currentUser || currentUser.type !== UserType.SHOP_OWNER) throw new Error('Unauthorized');
      await orderApi.requestRefund(orderId, reason);
      addNotification({ message: `Refund request initiated successfully.`, type: 'success' });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to initiate refund: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification]);

  const escalateTicketToAdmin = useCallback(async (ticketId: string, _reason: string): Promise<{ success: boolean; message?: string }> => {
    try {
      if (!currentUser || currentUser.type !== UserType.STUDENT) throw new Error('Unauthorized');
      await ticketApi.updateStatus(ticketId, TicketStatus.IN_REVIEW, 'Escalated by student');
      addNotification({ message: `Ticket escalated to Admin successfully.`, type: 'success' });
      fetchTickets();
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to escalate ticket: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification, fetchTickets]);

  // ══════════════════════════════════════════════════════════
  // ADMIN OTP / ACCOUNT ACTIONS
  // ══════════════════════════════════════════════════════════

  const requestAccountActionOTP = useCallback(async (actionId: string): Promise<{ success: boolean; message?: string }> => {
    try {
      return await adminApi.requestOTP(actionId);
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, []);

  const executeAccountAction = useCallback(async (action: string, otp: string, targetUid?: string, targetShopId?: string): Promise<{ success: boolean; message?: string }> => {
    try {
      await adminApi.executeAction(action, otp, targetUid, targetShopId);
      if (action === "DELETE_OWN_ACCOUNT") {
        api.clearTokens();
        setCurrentUserInternal(null);
      }
      // Refresh data after destructive actions so UI reflects changes immediately
      if (action === "DELETE_USER" || action === "ARCHIVE_USER") {
        fetchShops();
        fetchOrders();
      }
      addNotification({ message: 'Action completed successfully.', type: 'success' });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to complete action: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [addNotification, fetchShops, fetchOrders]);

  // ══════════════════════════════════════════════════════════
  // BANK DETAILS
  // ══════════════════════════════════════════════════════════

  const getBankDetails = useCallback(async (shopId: string): Promise<BankDetails | null> => {
    try { return await bankApi.get(shopId); } catch (err) { debugLog('[AppContext] getBankDetails error:', err); return null; }
  }, []);

  const saveBankDetails = useCallback(async (shopId: string, details: BankDetails): Promise<{ success: boolean; message?: string }> => {
    try {
      await bankApi.save(shopId, details);
      addNotification({ message: 'Bank details saved securely.', type: 'success', targetShopId: shopId });
      return { success: true };
    } catch (err) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [addNotification]);

  const getPaymentConfig = useCallback(async (shopId: string): Promise<PaymentConfiguration | null> => {
    try { return await bankApi.getPaymentConfig(shopId); } catch (err) { debugLog('[AppContext] getPaymentConfig error:', err); return null; }
  }, []);

  const verifyBankDetails = useCallback(async (shopId: string): Promise<{ success: boolean; message?: string }> => {
    try {
      await bankApi.verify(shopId);
      addNotification({ message: 'Bank details verified.', type: 'success', targetShopId: shopId });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [addNotification]);

  const logBankAccess = useCallback(async (_shopId: string, _action: 'VIEW' | 'EDIT' | 'VERIFY') => {
    // Logging is handled server-side now
  }, []);

  // ══════════════════════════════════════════════════════════
  // REACTIVATION REQUESTS
  // ══════════════════════════════════════════════════════════

  const submitReactivationRequest = useCallback(async (shopId: string, shopName: string): Promise<{ success: boolean; message?: string }> => {
    try {
      const result = await reactivationApi.submit(shopId, shopName);
      if (result.success) addNotification({ message: result.message || 'Reactivation request submitted.', type: 'success' });
      else addNotification({ message: result.message || 'Failed to submit.', type: 'error' });
      fetchReactivationRequests();
      return result;
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to submit reactivation request: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [addNotification, fetchReactivationRequests]);

  const resolveReactivationRequestFn = useCallback(async (requestId: string, action: 'approve' | 'reject', otp: string, rejectionReason?: string): Promise<{ success: boolean; message?: string }> => {
    try {
      const result = await reactivationApi.resolve(requestId, action, otp, rejectionReason);
      if (result.success) addNotification({ message: result.message || `Request ${action}ed.`, type: 'success' });
      else addNotification({ message: result.message || `Failed to ${action} request.`, type: 'error' });
      fetchReactivationRequests();
      return result;
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to ${action} request: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [addNotification, fetchReactivationRequests]);

  // Approved shops — only approved and non-archived shops visible to students
  const approvedShops = useMemo(() => shops.filter(s => s.isApproved && !s.isArchived), [shops]);

  const contextValue = useMemo(() => ({
    currentUser, isLoadingAuth,
    pendingProfileCreationType, pendingProfileEmail, pendingProfileName,
    pendingFirebaseProfileCreationUser, setPendingFirebaseProfileCreationUser,
    signInWithGoogle, signUpWithEmailPassword, signInWithEmailAndPassword: signInWithEmailAndPasswordInternal,
    completeStudentProfileCreation, completeShopOwnerProfileCreation, checkReturningShopOwner, logoutUser, refreshCurrentUser,
    shops, isLoadingShops, getShopById, registerShop, updateShopSettings,
    orders, allOrders, getOrdersForCurrentUser,
    notifications,
    addOrder, updateOrderStatus,
    addNotification, markNotificationAsRead, markAllNotificationsAsRead, getNotificationsForCurrentUser,
    currentView, navigateTo, goBack, upgradeToStudentPass, cancelStudentPass,
    payouts, createPayout, approvePayout, markPayoutPaid, rejectPayout, cancelPayout, requestPayout, confirmPayout, disputePayout,
    approveShop, rejectShop, archiveShop, unarchiveShop, approvedShops,
    requestAccountActionOTP,
    executeAccountAction,
    studentPassHolders,
    getBankDetails, saveBankDetails, verifyBankDetails, logBankAccess,
    getPaymentConfig,
    tickets, createTicket, addTicketMessage, updateTicketStatus,
    reports,
    archivedShopForCurrentUser,
    reactivationRequests,
    submitReactivationRequest,
    resolveReactivationRequest: resolveReactivationRequestFn,
    refundRequests,
    shopInitiateRefund,
    escalateTicketToAdmin,
    createRefundRequest: async (orderId: string, reason: string) => {
      try {
        await refundApi.create(orderId, reason);
        fetchRefundRequests();
        return { success: true };
      } catch (err) {
        return { success: false, message: getErrorMessage(err) };
      }
    },
    respondToRefundRequest: async (requestId: string, approved: boolean, shopResponse?: string) => {
      try {
        await refundApi.respond(requestId, approved, shopResponse);
        fetchRefundRequests();
        return { success: true };
      } catch (err) {
        return { success: false, message: getErrorMessage(err) };
      }
    },
    escalateRefundRequest: async (requestId: string) => {
      try {
        await refundApi.escalate(requestId);
        fetchRefundRequests();
        return { success: true };
      } catch (err) {
        return { success: false, message: getErrorMessage(err) };
      }
    },
    resolveRefundRequest: async (requestId: string, action: 'APPROVE' | 'DENY', otp: string, adminNote?: string) => {
      try {
        await refundApi.resolve(requestId, action, otp, adminNote);
        fetchRefundRequests();
        return { success: true };
      } catch (err) {
        return { success: false, message: getErrorMessage(err) };
      }
    },
    syncRefundHistory: async (orderId: string) => {
      try {
        return await refundApi.syncHistory(orderId);
      } catch (err) {
        return { success: false, count: 0, refunds: [], message: getErrorMessage(err) };
      }
    },
    ordersLimit, payoutsLimit, notificationsLimit, shopsLimit,
    loadMoreOrders, loadMorePayouts, loadMoreNotifications, loadMoreShops,
    refreshOrders: fetchOrders,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [
    currentUser, isLoadingAuth, pendingProfileCreationType, pendingProfileEmail, pendingProfileName,
    pendingGoogleToken, pendingFirebaseProfileCreationUser,
    shops, isLoadingShops, orders, allOrders, notifications, currentView, payouts, approvedShops, studentPassHolders,
    tickets, reports, archivedShopForCurrentUser, reactivationRequests, refundRequests,
    ordersLimit, payoutsLimit, notificationsLimit, shopsLimit, loadMoreOrders, loadMorePayouts, loadMoreNotifications, loadMoreShops
  ]);

  return (
    <AppContext.Provider value={contextValue}>
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = (): AppContextType => {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
};
