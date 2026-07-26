/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useState, useContext, useCallback, useMemo, ReactNode, useEffect, useRef } from 'react';
import { DocumentOrder, OrderFile, NotificationMessage, OrderStatus, User, UserType, ShopProfile, ShopPricing, PayoutMethod, AppView, ShopPayout, PrintColor, BankDetails, PaymentConfiguration, SupportTicket, TicketCategory, TicketStatus, TicketMessage, TicketStatusChange, EarningsReport, ReactivationRequest, RefundRequest } from '../types';
import { DEFAULT_SHOP_PRICING } from '../constants';
import {
  auth,
  db,
  storage,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
  getRedirectResult,
  signOut,
  functions,
  httpsCallable,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword as firebaseSignInWithEmailAndPassword,
  doc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,

  deleteField,
  writeBatch,
  collection,
  query,
  where,
  orderBy,
  limit,
  addDoc,
  FirebaseUser,
  storageRef,
  uploadBytesResumable,
  updateProfile,
  onSnapshot
} from '../firebase';

import { Capacitor } from '@capacitor/core';
import { playNewOrderSound, initAudioContext } from '../utils/notificationSound';

// Helper to safely extract error messages from unknown error types
const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'An unexpected error occurred.';
};

const isExpectedPermissionLoss = (err: unknown): boolean => {
  const error = err as { code?: string; message?: string };
  return error?.code === 'permission-denied' ||
    error?.message?.toLowerCase().includes('missing or insufficient permissions') === true;
};

// Pricing utilities — imported from dedicated module for clean HMR
import { calculateBaseFee, calculateOrderPrice, calculateMultiFileOrderPrice, isStudentPassActive, getStudentPassDaysRemaining, getStudentPassExpiryDate } from '../utils/pricing';
export { calculateBaseFee, calculateOrderPrice, calculateMultiFileOrderPrice, isStudentPassActive, getStudentPassDaysRemaining, getStudentPassExpiryDate };

// Push notification registration for native mobile
import { registerPushNotifications, unregisterPushNotifications } from '../utils/pushNotifications';

const isDevelopment = import.meta.env.DEV;
const debugLog = (...args: unknown[]) => {
  void isDevelopment;
  void args;
};

interface AppContextType {
  currentUser: User | null;
  isLoadingAuth: boolean;
  pendingFirebaseProfileCreationUser: FirebaseUser | null;
  setPendingFirebaseProfileCreationUser: React.Dispatch<React.SetStateAction<FirebaseUser | null>>;

  signInWithGoogle: () => Promise<void>;
  signUpWithEmailPassword: (email: string, password: string, displayName: string) => Promise<{ success: boolean; message?: string }>;
  signInWithEmailAndPassword: (email: string, password: string) => Promise<{ success: boolean; message?: string; errorCode?: string }>;
  completeStudentProfileCreation: (authUser: FirebaseUser, displayName?: string) => Promise<{ success: boolean; message?: string }>;
  completeShopOwnerProfileCreation: (authUser: FirebaseUser, shopDetails: { shopName: string; shopAddress: string }, displayName?: string) => Promise<{ success: boolean; message?: string; shopId?: string }>;
  checkReturningShopOwner: (email: string) => Promise<{ exists: boolean; hasActiveAccount?: boolean; hasArchivedShop?: boolean; isOwnerOrphaned?: boolean; oldUserId?: string; shop?: ShopProfile }>;

  // Reactivation Requests
  archivedShopForCurrentUser: ShopProfile | null;
  reactivationRequests: ReactivationRequest[];
  submitReactivationRequest: (shopId: string, shopName: string) => Promise<{ success: boolean; message?: string }>;
  resolveReactivationRequest: (requestId: string, action: 'approve' | 'reject', otp: string, rejectionReason?: string) => Promise<{ success: boolean; message?: string }>;
  logoutUser: () => Promise<void>;
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
  getNotificationsForCurrentUser: () => NotificationMessage[];

  currentView: AppView;
  navigateTo: (view: AppView) => void;
  goBack: () => void;

  // Admin subscription data
  studentPassHolders: { id: string; name?: string; email?: string; studentPassActivatedAt?: string; studentPassPaymentId?: string }[];

  // Admin payout functions
  payouts: ShopPayout[];
  createPayout: (shopId: string, shopName: string, amount: number, adminNote?: string, otp?: string) => Promise<{ success: boolean; message?: string }>;
  requestPayout: (shopId: string, shopName: string, amount: number, shopOwnerNote?: string) => Promise<{ success: boolean; message?: string }>;
  approvePayout: (payoutId: string, otp: string, adminNote?: string) => Promise<{ success: boolean; message?: string }>;
  rejectPayout: (payoutId: string, otp: string, adminNote?: string) => Promise<{ success: boolean; message?: string }>;
  cancelPayout: (payoutId: string, otp: string) => Promise<{ success: boolean; message?: string }>;
  confirmPayout: (payoutId: string) => Promise<{ success: boolean; message?: string }>;
  disputePayout: (payoutId: string, shopOwnerNote: string) => Promise<{ success: boolean; message?: string }>;

  // Admin shop management
  approveShop: (shopId: string) => Promise<{ success: boolean; message?: string }>;
  rejectShop: (shopId: string) => Promise<{ success: boolean; message?: string }>;
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
  addTicketMessage: (ticketId: string, message: string) => Promise<{ success: boolean; message?: string }>;
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
  syncRefundHistory: (orderId: string) => Promise<{ success: boolean; count: number; refunds: import('../types').RazorpayRefund[]; message?: string }>;

  // Pagination Controls
  ordersLimit: number;
  payoutsLimit: number;
  notificationsLimit: number;
  shopsLimit: number;
  loadMoreOrders: () => void;
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

// Helper function to clean payout methods array
const cleanPayoutMethods = (methods?: PayoutMethod[]): PayoutMethod[] => {
  if (!methods) return [];
  return methods.filter(method => method !== null && method !== undefined);
};

const normalizePayoutMethodsForStorage = (methods?: PayoutMethod[]): PayoutMethod[] => {
  return cleanPayoutMethods(methods).map((method) => {
    const common = {
      id: method.id,
      type: method.type,
      ...(method.nickname?.trim() ? { nickname: method.nickname.trim() } : {}),
      ...(method.isPrimary ? { isPrimary: true } : {}),
    };

    if (method.type === 'UPI') {
      return {
        ...common,
        upiId: method.upiId?.trim() || '',
      };
    }

    return {
      ...common,
      accountHolderName: method.accountHolderName?.trim() || '',
      accountNumber: method.accountNumber?.trim() || '',
      ifscCode: method.ifscCode?.trim() || '',
      bankName: method.bankName?.trim() || '',
    };
  });
};

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUserInternal] = useState<User | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState<boolean>(true);

  // --- Pagination State ---
  const [ordersLimit, setOrdersLimit] = useState(100);
  const [payoutsLimit, setPayoutsLimit] = useState(100);
  const [notificationsLimit, setNotificationsLimit] = useState(100);
  const [shopsLimit, setShopsLimit] = useState(50);

  const loadMoreOrders = useCallback(() => setOrdersLimit(prev => prev + 100), []);
  const loadMorePayouts = useCallback(() => setPayoutsLimit(prev => prev + 100), []);
  const loadMoreNotifications = useCallback(() => setNotificationsLimit(prev => prev + 50), []);
  const loadMoreShops = useCallback(() => setShopsLimit(prev => prev + 50), []);
  const [pendingFirebaseProfileCreationUser, setPendingFirebaseProfileCreationUser] = useState<FirebaseUser | null>(null);

  // Stable refs to break the dependency cycle: shops → addNotification → shops useEffect
  const addNotificationRef = useRef<(notification: Omit<NotificationMessage, 'id' | 'timestamp' | 'read'>) => void>(() => { });
  const shopsRef = useRef<ShopProfile[]>([]);
  const currentUserRef = useRef<User | null>(null);

  const [listedShops, setListedShops] = useState<ShopProfile[]>([]);
  const [supplementalShops, setSupplementalShops] = useState<Record<string, ShopProfile>>({});
  const [isLoadingShops, setIsLoadingShops] = useState<boolean>(true);
  const [orders, setOrders] = useState<DocumentOrder[]>([]);
  const [allOrders, setAllOrders] = useState<DocumentOrder[]>([]); // Admin: all orders
  const [payouts, setPayouts] = useState<ShopPayout[]>([]);
  const [studentPassHolders, setStudentPassHolders] = useState<{ id: string; name?: string; email?: string; studentPassActivatedAt?: string; studentPassPaymentId?: string }[]>([]);
  const [firestoreNotifications, setFirestoreNotifications] = useState<NotificationMessage[]>([]);
  const [localNotifications, setLocalNotifications] = useState<NotificationMessage[]>([]);
  const [currentView, setCurrentView] = useState<AppView>('landing');
  const viewHistoryRef = useRef<AppView[]>([]);

  const sortShopsForDisplay = useCallback((shopList: ShopProfile[]) =>
    [...shopList].sort((a, b) => {
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      if (bTime !== aTime) return bTime - aTime;
      return a.name.localeCompare(b.name);
    }), []);

  const shops = useMemo(() => {
    const mergedMap = new Map<string, ShopProfile>();
    listedShops.forEach((shop) => mergedMap.set(shop.id, shop));
    Object.values(supplementalShops).forEach((shop) => {
      if (!mergedMap.has(shop.id)) {
        mergedMap.set(shop.id, shop);
      }
    });
    return sortShopsForDisplay([...mergedMap.values()]);
  }, [listedShops, supplementalShops, sortShopsForDisplay]);

  // Merged notifications: Firestore (persistent, cross-user) + local (session-only toasts)
  const notifications = useMemo(() => {
    const merged = [...localNotifications, ...firestoreNotifications];

    const scoped = currentUser?.type === UserType.SHOP_OWNER && currentUser.shopId
      ? merged.filter(notification => !notification.targetShopId || notification.targetShopId === currentUser.shopId)
      : merged;

    return scoped.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [localNotifications, firestoreNotifications, currentUser]);

  const navigateTo = useCallback((view: AppView) => {
    setCurrentView(prev => {
      // Don't push duplicate consecutive entries
      if (prev !== view) {
        viewHistoryRef.current.push(prev);
        // Keep history bounded
        if (viewHistoryRef.current.length > 50) viewHistoryRef.current.shift();
      }
      return view;
    });
    window.scrollTo(0, 0);
  }, []);

  const goBack = useCallback(() => {
    const history = viewHistoryRef.current;
    if (history.length > 0) {
      const previousView = history.pop()!;
      setCurrentView(previousView);
      window.scrollTo(0, 0);
    }
  }, []);

  const addNotification = useCallback((notificationData: Omit<NotificationMessage, 'id' | 'timestamp' | 'read'>) => {
    const timestamp = new Date().toISOString();

    let recipientUserId = notificationData.targetUserId;

    // Route 'ADMIN' notifications locally
    if (recipientUserId === 'ADMIN') {
      recipientUserId = undefined;
      const localNotif: NotificationMessage = {
        ...notificationData,
        id: `local_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        timestamp,
        read: false,
      };
      // Only show if current user IS an admin
      if (currentUserRef.current?.type === UserType.ADMIN) {
        setLocalNotifications(prev => [localNotif, ...prev].slice(0, 20));
      }
      return;
    }

    if (!recipientUserId && notificationData.targetShopId) {
      const shop = shopsRef.current.find(s => s.id === notificationData.targetShopId);
      recipientUserId = shop?.ownerUserId;
    }

    // Bug 12: Notification creation removed from client to prevent phishing.
    // Cloud Functions handle cross-user DB messaging.
    // If recipient is NOT the current user, skip local toast.
    if (recipientUserId && recipientUserId !== currentUserRef.current?.id) {
      return;
    }

    // For shop owners, keep local toasts scoped to the active shop context.
    if (
      currentUserRef.current?.type === UserType.SHOP_OWNER &&
      currentUserRef.current.shopId &&
      notificationData.targetShopId &&
      notificationData.targetShopId !== currentUserRef.current.shopId
    ) {
      return;
    }

    // Local-only session toast for the acting user
    const localNotif: NotificationMessage = {
      ...notificationData,
      id: `local_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      timestamp,
      read: false,
    };
    setLocalNotifications(prev => [localNotif, ...prev].slice(0, 20));
  }, []);

  // Keep the ref in sync with the latest addNotification
  useEffect(() => {
    addNotificationRef.current = addNotification;
  }, [addNotification]);

  // Keep shopsRef in sync so addNotification can look up shop owners without depending on shops state
  useEffect(() => {
    shopsRef.current = shops;
  }, [shops]);

  // Keep currentUserRef in sync so addOrder reads the latest hasStudentPass without a stale closure
  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  // Clear session-only notifications when the authenticated account or active shop changes.
  // This prevents stale toasts from a deleted/recovered/previous shop account leaking into
  // the next session's notification bell.
  useEffect(() => {
    setLocalNotifications([]);
  }, [currentUser?.id, currentUser?.shopId]);

  // Register for push notifications when user logs in (native platforms only)
  useEffect(() => {
    if (currentUser?.id) {
      registerPushNotifications(currentUser.id, (title, body) => {
        // Show in-app notification when push arrives while app is in foreground
        addNotificationRef.current({ message: body || title, type: 'info' });

        // Note: We used to forcefully reconnect Firestore here via enableNetwork(db),
        // but that causes INTERNAL ASSERTION FAILED crashes in Firestore v11.9.0
        // Firebase handles its own WebSocket reconnection.
      });
    }
    return () => {
      if (currentUser?.id) {
        unregisterPushNotifications();
      }
    };
  }, [currentUser?.id]);

  // (Removed legacy enableNetwork() heartbeat polling logic here)
  // Firestore v11.9.0 strictly asserts internal thread state. Calling enableNetwork()
  // while the SDK is concurrently resetting due to Auth swaps or backgrounding 
  // causes fatal `INTERNAL ASSERTION FAILED: Unexpected state {"fe":-1}` crashes.
  // The SDK correctly manages its own graceful retries internally.

  // Shop data listener — self-healing: retries on error instead of wiping data.
  // Firebase auto-closes onSnapshot listeners on error, so we must re-subscribe.
  useEffect(() => {
    setIsLoadingShops(true);
    let hasReceivedServerData = false;
    let unsubscribeShops: (() => void) | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let loadingTimeout: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    let isCleaned = false;

    const subscribe = () => {
      if (isCleaned) return;
      const handleShopError = (_error: unknown) => {
        debugLog('[AppContext] Shops listener error:', _error);
        setIsLoadingShops(false);

        if (retryCount < MAX_RETRIES && !isCleaned) {
          retryCount++;
          const delay = Math.min(retryCount * 3000, 10000);
          debugLog(`[AppContext] Shops listener will retry in ${delay}ms (attempt ${retryCount}/${MAX_RETRIES})`);
          retryTimeout = setTimeout(() => {
            if (isCleaned) return;
            unsubscribeShops?.();
            unsubscribeShops = null;
            subscribe();
          }, delay);
        } else {
          addNotificationRef.current({
            message: "Unable to load shop data. Please check your connection and refresh.",
            type: 'error',
          });
        }
      };

      const handleFetchedShops = (fetchedShops: ShopProfile[], isFromCache: boolean) => {
        setListedShops(sortShopsForDisplay(fetchedShops));
        retryCount = 0;

        if (!isFromCache) {
          hasReceivedServerData = true;
          setIsLoadingShops(false);
        } else if (fetchedShops.length > 0) {
          setIsLoadingShops(false);
        } else if (!hasReceivedServerData) {
          loadingTimeout = setTimeout(() => {
            setIsLoadingShops(false);
          }, 5000);
        }
      };

      if (currentUser?.type === UserType.ADMIN) {
        unsubscribeShops = onSnapshot(
          query(collection(db, "shops"), limit(shopsLimit)),
          { includeMetadataChanges: true },
          (querySnapshot) => {
            const fetchedShops: ShopProfile[] = [];
            querySnapshot.forEach((docSnap) => {
              fetchedShops.push({ id: docSnap.id, ...docSnap.data() } as ShopProfile);
            });
            handleFetchedShops(fetchedShops, querySnapshot.metadata.fromCache);
          },
          handleShopError
        );
        return;
      }

      if (currentUser?.type === UserType.SHOP_OWNER && currentUser.shopId) {
        unsubscribeShops = onSnapshot(
          doc(db, "shops", currentUser.shopId),
          { includeMetadataChanges: true },
          (docSnap) => {
            const fetchedShops = docSnap.exists()
              ? [{ id: docSnap.id, ...docSnap.data() } as ShopProfile]
              : [];
            handleFetchedShops(fetchedShops, docSnap.metadata.fromCache);
          },
          handleShopError
        );
        return;
      }

      unsubscribeShops = onSnapshot(
        query(
          collection(db, "shops"),
          where("isApproved", "==", true),
          orderBy("name"),
          limit(shopsLimit)
        ),
        { includeMetadataChanges: true },
        (querySnapshot) => {
          const fetchedShops: ShopProfile[] = [];
          querySnapshot.forEach((docSnap) => {
            fetchedShops.push({ id: docSnap.id, ...docSnap.data() } as ShopProfile);
          });
          handleFetchedShops(fetchedShops, querySnapshot.metadata.fromCache);
        },
        handleShopError
      );
    };

    subscribe();

    return () => {
      isCleaned = true;
      unsubscribeShops?.();
      if (retryTimeout) clearTimeout(retryTimeout);
      if (loadingTimeout) clearTimeout(loadingTimeout);
    };
  }, [currentUser?.id, currentUser?.shopId, currentUser?.type, shopsLimit, sortShopsForDisplay]);

  useEffect(() => {
    const candidateShopIds = new Set<string>();

    if (currentUser?.type === UserType.SHOP_OWNER && currentUser.shopId) {
      candidateShopIds.add(currentUser.shopId);
    }

    if (currentUser?.type === UserType.STUDENT) {
      orders.forEach((order) => {
        if (order.shopId) {
          candidateShopIds.add(order.shopId);
        }
      });
    }

    const missingShopIds = [...candidateShopIds].filter((shopId) =>
      !shops.some((shop) => shop.id === shopId) && !supplementalShops[shopId]
    );

    if (missingShopIds.length === 0) {
      return;
    }

    let isCancelled = false;

    Promise.all(missingShopIds.map((shopId) => getDoc(doc(db, "shops", shopId))))
      .then((shopDocs) => {
        if (isCancelled) return;

        setSupplementalShops((prev) => {
          const next = { ...prev };
          shopDocs.forEach((shopDoc) => {
            if (shopDoc.exists()) {
              next[shopDoc.id] = { id: shopDoc.id, ...shopDoc.data() } as ShopProfile;
            }
          });
          return next;
        });
      })
      .catch((error) => {
        debugLog('[AppContext] Failed to load supplemental shops:', error);
      });

    return () => {
      isCancelled = true;
    };
  }, [currentUser?.shopId, currentUser?.type, orders, shops, supplementalShops]);


  // Track order statuses for paid-order sound detection (shop owners only)
  const knownOrderStatusesRef = useRef<Map<string, string> | null>(null);
  const isFirstOrderLoadRef = useRef(true);

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

  // Orders listener - dynamically queries based on currentUser
  // Uses addNotificationRef to avoid re-subscribing when addNotification identity changes
  useEffect(() => {
    if (!currentUser) {
      setOrders([]);
      setAllOrders([]);
      knownOrderStatusesRef.current = null;
      isFirstOrderLoadRef.current = true;
      return;
    }

    // Admin: listen to ALL orders
    if (currentUser.type === UserType.ADMIN) {
      const allOrdersQuery = query(collection(db, "orders"), orderBy("uploadedAt", "desc"), limit(ordersLimit));
      const unsubscribeAllOrders = onSnapshot(allOrdersQuery, (querySnapshot) => {
        const fetchedOrders: DocumentOrder[] = [];
        querySnapshot.forEach((doc) => {
          fetchedOrders.push({ id: doc.id, ...doc.data() } as DocumentOrder);
        });
        setAllOrders(fetchedOrders);
        setOrders(fetchedOrders); // Also set orders for compatibility
      }, (_error) => {
        if (!isExpectedPermissionLoss(_error)) {
          debugLog("[AppContext] All-orders listener error:", (_error as { message?: string })?.message || _error);
        }
      });
      return () => unsubscribeAllOrders();
    }

    let ordersQuery;
    if (currentUser.type === UserType.STUDENT) {
      ordersQuery = query(collection(db, "orders"), where("userId", "==", currentUser.id), orderBy("uploadedAt", "desc"), limit(ordersLimit));
    } else if (currentUser.type === UserType.SHOP_OWNER && currentUser.shopId) {
      ordersQuery = query(collection(db, "orders"), where("shopId", "==", currentUser.shopId), orderBy("uploadedAt", "desc"), limit(ordersLimit));
    } else {
      setOrders([]);
      return;
    }

    const unsubscribeOrders = onSnapshot(ordersQuery, (querySnapshot) => {
      const fetchedOrders: DocumentOrder[] = [];
      querySnapshot.forEach((doc) => {
        fetchedOrders.push({ id: doc.id, ...doc.data() } as DocumentOrder);
      });

      // Paid-order sound for shop owners (web only)
      // Only plays when an order transitions TO PENDING_APPROVAL (payment completed)
      if (currentUser.type === UserType.SHOP_OWNER && !Capacitor.isNativePlatform()) {
        const currentStatuses = new Map(fetchedOrders.map(o => [o.id, o.status]));
        if (isFirstOrderLoadRef.current) {
          // First load — just record statuses, don't play sound
          knownOrderStatusesRef.current = currentStatuses;
          isFirstOrderLoadRef.current = false;
        } else if (knownOrderStatusesRef.current) {
          // Check for orders that just became PENDING_APPROVAL (payment completed)
          let hasNewPaidOrder = false;
          for (const order of fetchedOrders) {
            if (order.status === OrderStatus.PENDING_APPROVAL) {
              const prevStatus = knownOrderStatusesRef.current.get(order.id);
              // Sound if: order is new with PENDING_APPROVAL, or transitioned from another status
              if (prevStatus !== OrderStatus.PENDING_APPROVAL) {
                hasNewPaidOrder = true;
                debugLog(`[AppContext] Paid order detected: #${order.id.slice(-6)} (was: ${prevStatus || 'new'})`);
              }
            }
          }
          if (hasNewPaidOrder) {
            playNewOrderSound();
          }
          knownOrderStatusesRef.current = currentStatuses;
        }
      }

      setOrders(fetchedOrders);
    }, (_error) => {
      if (!isExpectedPermissionLoss(_error)) {
        debugLog("[AppContext] Orders listener error:", (_error as { message?: string })?.message || _error);
      }
    });

    return () => {
      unsubscribeOrders();
    };
  }, [currentUser, ordersLimit]);

  // Payouts listener - for admin (all payouts) and shop owners (their payouts)
  useEffect(() => {
    if (!currentUser) {
      setPayouts([]);
      return;
    }

    let payoutsQuery;
    if (currentUser.type === UserType.ADMIN) {
      payoutsQuery = query(collection(db, "payouts"), orderBy("createdAt", "desc"), limit(payoutsLimit));
    } else if (currentUser.type === UserType.SHOP_OWNER && currentUser.shopId) {
      payoutsQuery = query(collection(db, "payouts"), where("shopId", "==", currentUser.shopId), orderBy("createdAt", "desc"), limit(payoutsLimit));
    } else {
      setPayouts([]);
      return;
    }

    const unsubscribePayouts = onSnapshot(payoutsQuery, (querySnapshot) => {
      const fetchedPayouts: ShopPayout[] = [];
      querySnapshot.forEach((doc) => {
        fetchedPayouts.push({ id: doc.id, ...doc.data() } as ShopPayout);
      });
      setPayouts(fetchedPayouts);
    }, (error) => {
      if (!isExpectedPermissionLoss(error)) {
        debugLog("[AppContext] Payouts listener error:", error.message || error);
      }
    });

    return () => unsubscribePayouts();
  }, [currentUser, payoutsLimit]);


  // Notifications listener - real-time Firestore notifications for the current user
  useEffect(() => {
    if (!currentUser) {
      setFirestoreNotifications([]);
      return;
    }

    const notifQuery = query(
      collection(db, "notifications"),
      where("recipientUserId", "==", currentUser.id),
      orderBy("timestamp", "desc"),
      limit(notificationsLimit)
    );

    const unsubscribeNotifs = onSnapshot(notifQuery, (querySnapshot) => {
      const fetched: NotificationMessage[] = [];
      querySnapshot.forEach((docSnap) => {
        fetched.push({ id: docSnap.id, ...docSnap.data() } as NotificationMessage);
      });
      setFirestoreNotifications(fetched);
    }, (error) => {
      if (!isExpectedPermissionLoss(error)) {
        debugLog("[AppContext] Error listening to notifications:", error);
      }
    });

    return () => unsubscribeNotifs();
  }, [currentUser, notificationsLimit]);

  // Real-time listener on the current user's Firestore document.
  // Detects admin deletion/rejection: when the doc is deleted, sign the user out immediately.
  // onAuthStateChanged does NOT fire when only the Firestore doc is removed — the Firebase Auth
  // session is still valid. This listener fills that gap.
  useEffect(() => {
    if (!currentUser?.id) return;

    const userDocRef = doc(db, "users", currentUser.id);
    let isFirstSnapshot = true;

    const unsubscribeUserDoc = onSnapshot(userDocRef, (docSnap) => {
      // Skip the first snapshot — we already have the user data from onAuthStateChanged
      if (isFirstSnapshot) {
        isFirstSnapshot = false;
        return;
      }

      if (!docSnap.exists()) {
        // Document was deleted (admin action) — sign out immediately
        debugLog('[AppContext] User document deleted (admin action). Signing out.');
        addNotificationRef.current({
          message: 'Your account has been removed by the administrator.',
          type: 'warning',
        });
        setCurrentUserInternal(null);
        setPendingFirebaseProfileCreationUser(null);
        signOut(auth).catch((err) => {
          debugLog('[AppContext] signOut after admin deletion failed:', err);
        });
      } else {
        // Document was updated — sync the latest data (e.g., role changes, pass status)
        const updatedData = docSnap.data() as User;

        // Auto-expire Student Pass if 30 days have elapsed
        if (updatedData.hasStudentPass && updatedData.studentPassActivatedAt) {
          const passStillActive = isStudentPassActive(updatedData.hasStudentPass, updatedData.studentPassActivatedAt);
          if (!passStillActive) {
            debugLog('[AppContext] Student Pass expired — auto-deactivating.');
            const userRef = doc(db, "users", updatedData.id);
            updateDoc(userRef, { hasStudentPass: false }).catch(err =>
              debugLog('[AppContext] Failed to auto-expire pass in Firestore:', err)
            );
            updatedData.hasStudentPass = false;
          }
        }

        setCurrentUserInternal(updatedData);
      }
    }, (error) => {
      debugLog('[AppContext] User document listener error:', error);
      // Don't sign out on listener errors — could be a transient network issue
    });

    return () => unsubscribeUserDoc();
  }, [currentUser?.id]);

  // Student Pass holders listener — admin only, for subscription revenue tracking
  useEffect(() => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      setStudentPassHolders([]);
      return;
    }

    const passQuery = query(
      collection(db, 'users'),
      where('hasStudentPass', '==', true),
      limit(1000)
    );

    const unsubscribePass = onSnapshot(passQuery, (querySnapshot) => {
      const holders: typeof studentPassHolders = [];
      querySnapshot.forEach((docSnap) => {
        const data = docSnap.data();
        holders.push({
          id: docSnap.id,
          name: data.name,
          email: data.email,
          studentPassActivatedAt: data.studentPassActivatedAt,
          studentPassPaymentId: data.studentPassPaymentId,
        });
      });
      setStudentPassHolders(holders);
    }, (error) => {
      debugLog('[AppContext] Error listening to student pass holders:', error);
    });

    return () => unsubscribePass();
  }, [currentUser]);

  useEffect(() => {
    setIsLoadingAuth(true);
    const notifyError = (msg: string) => addNotificationRef.current({ message: msg, type: 'error' });

    // Handle redirect result (for Android WebView where signInWithRedirect is used)
    // This must be called before onAuthStateChanged to catch the redirect return
    getRedirectResult(auth).then((result) => {
      if (result) {
        debugLog('[AppContext] Google redirect sign-in completed successfully');
        // onAuthStateChanged will handle the rest
      }
    }).catch((error) => {
      debugLog('[AppContext] getRedirectResult error:', error);
      // Don't show error for "no redirect result" — that's normal on non-redirect flows
      const firebaseError = error as { code?: string };
      if (firebaseError.code && firebaseError.code !== 'auth/popup-closed-by-user') {
        notifyError('Google sign-in failed. Please try again.');
      }
      setIsLoadingAuth(false);
    });

    const unsubscribe = onAuthStateChanged(auth, async (authUser) => {
      if (authUser) {
        // Helper: fetch user doc with retry for offline/network errors
        const fetchUserDoc = async (uid: string, retries = 2): Promise<import('firebase/firestore').DocumentSnapshot> => {
          const userDocRef = doc(db, "users", uid);
          for (let attempt = 0; attempt <= retries; attempt++) {
            try {
              return await getDoc(userDocRef);
            } catch (fetchErr) {
              if (attempt < retries) {
                debugLog(`[AppContext] Profile fetch attempt ${attempt + 1} failed, retrying...`, fetchErr);
                await new Promise(r => setTimeout(r, 1500));
              } else {
                throw fetchErr;
              }
            }
          }
          throw new Error('Exhausted retries');
        };

        try {
          const userDocSnap = await fetchUserDoc(authUser.uid);

          if (userDocSnap.exists()) {
            const userData = userDocSnap.data() as User & { isDeleted?: boolean };
            if (userData.isDeleted) {
              // Ignore soft-deleted accounts — effectively treating them as new
              setCurrentUserInternal(null);
              setPendingFirebaseProfileCreationUser(authUser);
            } else {
              setCurrentUserInternal(userData);
              setPendingFirebaseProfileCreationUser(null);
            }
          } else {
            // Profile doesn't exist in Firestore.
            // First, try to recover a shop owner profile when an earlier partial
            // signup created the shop document but failed before writing /users/{uid}.
            const ownedShopsQuery = query(
              collection(db, "shops"),
              where("ownerUserId", "==", authUser.uid),
              limit(1)
            );
            const ownedShopsSnap = await getDocs(ownedShopsQuery);

            if (!ownedShopsSnap.empty) {
              const ownedShopDoc = ownedShopsSnap.docs[0];
              const ownedShop = ownedShopDoc.data() as ShopProfile;
              const recoveredShopOwnerProfile: User = {
                id: authUser.uid,
                name: authUser.displayName || authUser.email?.split('@')[0] || 'Shop Owner',
                type: UserType.SHOP_OWNER,
                shopId: ownedShopDoc.id,
                ...(authUser.email && { email: authUser.email }),
              };

              await setDoc(doc(db, "users", authUser.uid), recoveredShopOwnerProfile);
              setCurrentUserInternal(recoveredShopOwnerProfile);
              setPendingFirebaseProfileCreationUser(null);
              addNotificationRef.current({
                message: `Recovered your shop account for "${ownedShop.name}".`,
                type: 'success',
                targetShopId: ownedShopDoc.id,
              });
            } else if (currentUserRef.current?.id === authUser.uid) {
              // Same authenticated user lost their profile doc while signed in:
              // treat this as an admin deletion and sign them out.
              debugLog('[AppContext] Profile was deleted (admin action). Signing out user.');
              addNotificationRef.current({ message: 'Your account has been removed by the administrator.', type: 'warning' });
              setCurrentUserInternal(null);
              setPendingFirebaseProfileCreationUser(null);
              await signOut(auth);
            } else {
              // Genuinely new user — show profile creation form.
              setCurrentUserInternal(null);
              setPendingFirebaseProfileCreationUser(authUser);
            }
          }
        } catch (error) {
          debugLog('[AppContext] Failed to load profile after retries:', error);
          // DON'T clear currentUser on network errors — the user may have signed in
          // successfully via signInWithGoogle which already set the user state.
          // Only show error if we don't already have a valid user.
          if (!currentUserRef.current) {
            notifyError("Error loading your profile. Please check your connection and try again.");
          }
          // Don't clear state — leave whatever currentUser/pending state exists
        } finally {
          setIsLoadingAuth(false);
        }
      } else {
        // User signed out (or admin deleted their Firebase Auth account)
        setCurrentUserInternal(null);
        setPendingFirebaseProfileCreationUser(null);
        setIsLoadingAuth(false);
      }
    });
    return () => unsubscribe();
  }, [currentUserRef]);


  const handleAuthError = (error: unknown): { message: string; errorCode?: string } => {
    let message = `Authentication failed. Please try again.`;
    const firebaseError = error as { code?: string; message?: string };
    const errorCode = firebaseError.code;

    if (errorCode) {
      switch (errorCode) {
        case 'auth/invalid-email': message = 'Invalid email address format.'; break;
        case 'auth/user-disabled': message = 'This user account has been disabled.'; break;
        case 'auth/user-not-found': message = 'No account found with this email. Please check your email or Sign Up.'; break;
        case 'auth/wrong-password': message = 'Incorrect password. Please try again.'; break;
        case 'auth/email-already-in-use': message = 'This email is already registered. Try logging in or use a different email.'; break;
        case 'auth/weak-password': message = 'Password is too weak. Please choose a stronger password (at least 6 characters).'; break;
        case 'auth/operation-not-allowed': message = 'Email/password sign-in is not enabled. Contact support.'; break;
        case 'auth/invalid-credential': message = 'Invalid credentials. Please check your email and password, or Sign Up if you don\'t have an account.'; break;
        default: message = firebaseError.message || 'An unexpected error occurred during authentication.';
      }
    }
    addNotification({ message, type: 'error' });
    return { message, errorCode };
  };

  const signInWithGoogle = async (): Promise<void> => {
    setIsLoadingAuth(true);
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({
      prompt: 'select_account'
    });

    const isNative = Capacitor.isNativePlatform();

    try {
      if (isNative) {
        // Native Android/iOS: use native Google Sign-In via Credential Manager.
        // Google blocks signInWithPopup/Redirect in WebViews with "disallowed_useragent".
        debugLog('[AppContext] Attempting native Google Sign-In...');
        const success = await attemptNativeGoogleSignIn();
        if (!success) {
          throw new Error('Native Google Sign-In returned no result. Please ensure Google Play Services is up to date.');
        }
        debugLog('[AppContext] Native Google Sign-In + Firebase credential completed');
      } else {
        // Web browser: use signInWithPopup
        debugLog('[AppContext] Using signInWithPopup for web...');
        try {
          await signInWithPopup(auth, provider);
          debugLog('[AppContext] signInWithPopup resolved normally');
        } catch (popupErr: unknown) {
          // COOP (Cross-Origin-Opener-Policy) can cause signInWithPopup to throw
          // even when the auth actually succeeded via onAuthStateChanged.
          // Check if Firebase already has a valid user before treating it as failure.
          if (auth.currentUser) {
            debugLog('[AppContext] signInWithPopup threw but auth.currentUser exists — sign-in succeeded despite COOP');
          } else {
            throw popupErr; // Re-throw — it's a real failure
          }
        }
      }

      // Auth succeeded. DON'T load the profile here — let onAuthStateChanged
      // be the single source of truth. Loading the profile both here AND in
      // onAuthStateChanged creates a race condition where two getDoc calls run
      // simultaneously. If Firestore's WebSocket is recovering from the popup
      // stealing focus, these parallel reads can trigger internal assertion errors.
      // onAuthStateChanged fires automatically after signInWithPopup/signInWithCredential
      // completes, and its handler already has retry logic.
      if (auth.currentUser) {
        debugLog('[AppContext] Auth succeeded for:', auth.currentUser.email, '— onAuthStateChanged will handle profile loading');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      debugLog('[AppContext] Google Sign-In error:', errorMessage);

      // Don't show error if user just cancelled the sign-in
      const lower = errorMessage.toLowerCase();
      const isCancellation = lower.includes('user canceled') ||
        lower.includes('user cancelled') ||
        lower.includes('sign_in_cancelled') ||
        lower.includes('sign in action cancelled') ||
        lower.includes('canceled by user') ||
        lower.includes('popup-closed-by-user') ||
        lower.includes('cancelled-popup-request');

      if (!isCancellation) {
        addNotification({ message: `Google Sign-In failed: ${errorMessage}`, type: 'error' });
      }
      setCurrentUserInternal(null);
      setPendingFirebaseProfileCreationUser(null);
    } finally {
      setIsLoadingAuth(false);
    }
  };

  // Helper: Attempt native Google Sign-In using Capacitor plugin
  // Returns true if successful, throws on error, returns false if plugin unavailable
  const attemptNativeGoogleSignIn = async (): Promise<boolean> => {
    const { SocialLogin } = await import('@capgo/capacitor-social-login');

    await SocialLogin.initialize({
      google: {
        webClientId: '283831997162-p8afki1sjtfa9srdvr6infpf06gofmk5.apps.googleusercontent.com',
      },
    });

    const result = await SocialLogin.login({
      provider: 'google',
      options: {
        scopes: ['email', 'profile'],
      },
    });

    const loginResponse = result?.result;
    if (!loginResponse || loginResponse.responseType !== 'online') {
      debugLog('[AppContext] Native sign-in returned non-online response:', loginResponse);
      return false;
    }

    const idToken = loginResponse.idToken;
    if (!idToken) {
      debugLog('[AppContext] Native sign-in returned no idToken');
      return false;
    }

    const credential = GoogleAuthProvider.credential(idToken);
    await signInWithCredential(auth, credential);
    return true;
  };

  const signUpWithEmailPassword = async (email: string, password: string, displayName: string): Promise<{ success: boolean; message?: string }> => {
    setIsLoadingAuth(true);
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      if (userCredential.user && displayName) {
        await updateProfile(userCredential.user, { displayName });
      }
      return { success: true };
    } catch (err: unknown) {
      const { message } = handleAuthError(err);
      setCurrentUserInternal(null);
      setPendingFirebaseProfileCreationUser(null);
      setIsLoadingAuth(false);
      return { success: false, message };
    }
  };

  const signInWithEmailAndPasswordInternal = async (email: string, password: string): Promise<{ success: boolean; message?: string; errorCode?: string }> => {
    setIsLoadingAuth(true);
    try {
      await firebaseSignInWithEmailAndPassword(auth, email, password);
      return { success: true };
    } catch (err: unknown) {
      const { message, errorCode } = handleAuthError(err);
      setCurrentUserInternal(null);
      setPendingFirebaseProfileCreationUser(null);
      setIsLoadingAuth(false);
      return { success: false, message, errorCode };
    }
  };

  const completeStudentProfileCreation = useCallback(async (authUser: FirebaseUser, displayName?: string): Promise<{ success: boolean; message?: string }> => {
    setIsLoadingAuth(true);
    try {
      const studentName = displayName || authUser.displayName || 'Student';
      const studentProfileData: User = {
        id: authUser.uid,
        name: studentName,
        type: UserType.STUDENT,
        ...(authUser.email && { email: authUser.email }),
      };

      await setDoc(doc(db, "users", authUser.uid), studentProfileData);

      setCurrentUserInternal(studentProfileData);
      setPendingFirebaseProfileCreationUser(null);

      addNotification({ message: `Welcome, ${studentName}! Registration successful.`, type: 'success', targetUserId: studentProfileData.id });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Registration failed: ${message}`, type: 'error' });
      try {
        if (auth.currentUser) await signOut(auth);
      } catch (signOutErr) {
        debugLog('[AppContext] Failed to sign out after profile creation error:', getErrorMessage(signOutErr));
      }
      return { success: false, message };
    } finally {
      setIsLoadingAuth(false);
    }
  }, [addNotification]);

  const registerShop = useCallback(async (shopName: string, shopAddress: string, ownerUserId: string, initialPricing: ShopPricing): Promise<ShopProfile | null> => {
    const shopDocRef = doc(collection(db, "shops"));
    const newShopId = shopDocRef.id;

    const newShopData: ShopProfile = {
      id: newShopId,
      ownerUserId,
      name: shopName,
      address: shopAddress,
      createdAt: new Date().toISOString(),
      customPricing: initialPricing,
      isOpen: true,
      isApproved: false,
      isVerified: false
    };
    try {
      await setDoc(shopDocRef, newShopData);
      return newShopData;
    } catch (err) {
      const error = err as Error;
      addNotification({ message: `Failed to register shop: ${error.message}`, type: 'error' });
      return null;
    }
  }, [addNotification]);

  const checkReturningShopOwner = useCallback(async (email: string) => {
    try {
      const func = httpsCallable<{ email: string }, unknown>(functions, 'checkReturningShopOwner');
      const result = await func({ email });
      return result.data as { exists: boolean; hasActiveAccount?: boolean; hasArchivedShop?: boolean; isOwnerOrphaned?: boolean; oldUserId?: string; shop?: ShopProfile };
    } catch (err) {
      debugLog("Error checking returning shopowner:", err);
      return { exists: false };
    }
  }, []);

  // --- Reactivation Requests ---
  const [archivedShopForCurrentUser, setArchivedShopForCurrentUser] = useState<ShopProfile | null>(null);
  const [reactivationRequests, setReactivationRequests] = useState<ReactivationRequest[]>([]);

  const submitReactivationRequest = useCallback(async (shopId: string, shopName: string): Promise<{ success: boolean; message?: string }> => {
    try {
      const func = httpsCallable(functions, 'submitReactivationRequest');
      const result = await func({ shopId, shopName });
      const data = result.data as { success: boolean; message?: string };
      if (data.success) {
        addNotification({ message: data.message || 'Reactivation request submitted.', type: 'success' });
        return { success: true, message: data.message };
      } else {
        addNotification({ message: data.message || 'Failed to submit reactivation request.', type: 'error' });
        return { success: false, message: data.message };
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to submit reactivation request: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [addNotification]);

  const resolveReactivationRequestFn = useCallback(async (requestId: string, action: 'approve' | 'reject', otp: string, rejectionReason?: string): Promise<{ success: boolean; message?: string }> => {
    try {
      const func = httpsCallable(functions, 'resolveReactivationRequest');
      const result = await func({ requestId, action, otp, rejectionReason });
      const data = result.data as { success: boolean; message?: string };
      if (data.success) {
        addNotification({ message: data.message || `Request ${action}ed.`, type: 'success' });
        return { success: true, message: data.message };
      } else {
        addNotification({ message: data.message || `Failed to ${action} request.`, type: 'error' });
        return { success: false, message: data.message };
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to ${action} request: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [addNotification]);

  const completeShopOwnerProfileCreation = useCallback(async (
    authUser: FirebaseUser,
    shopDetails: { shopName: string; shopAddress: string },
    displayName?: string
  ): Promise<{ success: boolean; message?: string; shopId?: string }> => {
    setIsLoadingAuth(true);

    const trimmedShopName = shopDetails.shopName.trim();
    if (!trimmedShopName) {
      setIsLoadingAuth(false);
      const message = "Shop name cannot be empty.";
      addNotification({ message, type: 'error' });
      return { success: false, message };
    }

    const existingShop = shops.find(s => s.name.trim().toLowerCase() === trimmedShopName.toLowerCase());

    if (existingShop) {
      const ownerDocRef = doc(db, 'users', existingShop.ownerUserId);
      try {
        const ownerDocSnap = await getDoc(ownerDocRef);
        if (!existingShop.isArchived && ownerDocSnap.exists()) {
          setIsLoadingAuth(false);
          const message = `A shop with the name "${trimmedShopName}" already exists. Please choose a different name.`;
          addNotification({ message, type: 'error' });
          return { success: false, message };
        }
      } catch (err) {
        debugLog("Error checking existing shop owner:", err);
      }
    }

    let newShop: ShopProfile | null = null;
    try {
      newShop = await registerShop(trimmedShopName, shopDetails.shopAddress, authUser.uid, DEFAULT_SHOP_PRICING);

      if (!newShop || typeof newShop.id !== 'string' || newShop.id.trim() === '') {
        throw new Error("Failed to register shop profile in Firestore. Shop data or ID is null/invalid or not a string.");
      }

      const ownerName = displayName || authUser.displayName || 'Shop Owner';

      const shopOwnerProfileData: User = {
        id: authUser.uid,
        name: ownerName,
        type: UserType.SHOP_OWNER,
        shopId: newShop.id,
        ...(authUser.email && { email: authUser.email }),
      };

      await setDoc(doc(db, "users", authUser.uid), shopOwnerProfileData);

      setCurrentUserInternal(shopOwnerProfileData);
      setPendingFirebaseProfileCreationUser(null);

      addNotification({ message: `Welcome, ${ownerName}! Shop '${newShop.name}' registered and is pending admin approval.`, type: 'success', targetUserId: shopOwnerProfileData.id });
      return { success: true, shopId: newShop.id };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Shop registration failed: ${message}`, type: 'error' });
      try {
        if (auth.currentUser) await signOut(auth);
      } catch (signOutErr) {
        debugLog('[AppContext] Failed to sign out after shop registration error:', getErrorMessage(signOutErr));
      }
      return { success: false, message };
    } finally {
      setIsLoadingAuth(false);
    }
  }, [registerShop, addNotification, shops]);

  const logoutUser = async (): Promise<void> => {
    setIsLoadingAuth(true);
    try {
      await signOut(auth);
    } catch (err: unknown) {
      handleAuthError(err);
    } finally {
      setIsLoadingAuth(false);
    }
  };

  const upgradeToStudentPass = async (): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser) return { success: false, message: "Not logged in" };

    try {
      if (currentUser.type !== UserType.STUDENT) {
        return { success: false, message: "Only students can upgrade to Student Pass." };
      }

      // Only update local state — the actual Firestore write happens in the server-side
      // verifyPassPayment Cloud Function after payment verification.
      // This prevents bypassing payment by calling upgradeToStudentPass directly.
      setCurrentUserInternal(prev => prev ? { ...prev, hasStudentPass: true } : null);

      addNotification({
        message: "Congratulations! You have upgraded to Student Pass.",
        type: 'success',
        targetUserId: currentUser.id
      });

      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  };

  const cancelStudentPass = async (): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser) return { success: false, message: "Not logged in" };

    try {
      if (currentUser.type !== UserType.STUDENT) {
        return { success: false, message: "Only students can cancel Student Pass." };
      }

      const userRef = doc(db, "users", currentUser.id);
      await updateDoc(userRef, { hasStudentPass: false });

      setCurrentUserInternal(prev => prev ? { ...prev, hasStudentPass: false } : null);

      addNotification({
        message: "Your Student Pass has been cancelled. You will no longer receive the service fee discount.",
        type: 'info',
        targetUserId: currentUser.id
      });

      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  };

  const getShopById = useCallback((shopId: string) => shops.find(s => s.id === shopId), [shops]);

  const updateShopSettings = useCallback(async (shopId: string, newSettings: { pricing: ShopPricing; isOpen: boolean; payoutMethods?: PayoutMethod[]; contactPhone?: string; contactPhoneAlt?: string; contactEmail?: string; whatsappNumber?: string }) => {
    try {
      const shopRef = doc(db, "shops", shopId);
      const updateData: Partial<ShopProfile> = {
        customPricing: newSettings.pricing,
        isOpen: newSettings.isOpen,
      };

      const normalizedContactFields = {
        contactPhone: newSettings.contactPhone?.trim(),
        contactPhoneAlt: newSettings.contactPhoneAlt?.trim(),
        contactEmail: newSettings.contactEmail?.trim(),
        whatsappNumber: newSettings.whatsappNumber?.trim(),
      };

      const contactFieldUpdates = Object.fromEntries(
        Object.entries(normalizedContactFields).map(([key, value]) => [key, value ? value : deleteField()])
      );

      const batch = writeBatch(db);
      batch.update(shopRef, { ...updateData, ...contactFieldUpdates });

      if (newSettings.payoutMethods) {
        const configDocRef = doc(db, 'shops', shopId, 'private', 'paymentConfig');
        batch.set(configDocRef, {
          payoutMethods: normalizePayoutMethodsForStorage(newSettings.payoutMethods),
          updatedAt: new Date().toISOString()
        });
      }

      await batch.commit();

      const shopFromState = shops.find(s => s.id === shopId);
      addNotification({
        message: `Settings updated for shop ${shopFromState?.name || shopId}.`,
        type: 'success',
        targetShopId: shopId,
        ...(shopFromState?.ownerUserId && { targetUserId: shopFromState.ownerUserId })
      });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to update shop settings: ${message}`, type: 'error', targetShopId: shopId });
      return { success: false, message };
    }
  }, [addNotification, shops]);


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

    // Calculate price using multi-file pricing (per-file copies, color, doubleSided)
    // Use expiry-aware pass check — pass only counts if still within 30-day window
    const userPassActive = isStudentPassActive(
      currentUserRef.current?.hasStudentPass,
      currentUserRef.current?.studentPassActivatedAt
    );
    const calculatedPriceDetails = calculateMultiFileOrderPrice(
      fileInputs.map(f => ({ pageCount: f.pageCount, color: f.color, copies: f.copies, doubleSided: f.doubleSided })),
      targetShop.customPricing,
      userPassActive
    );

    const totalFiles = fileInputs.length;
    const fileProgressMap = new Map<number, number>(); // index -> progress (0-1)

    // 1. Initialize the order draft on the backend first so clients cannot forge
    // arbitrary order documents just to satisfy Storage rules.
    let orderId = '';
    let verifiedPrice = calculatedPriceDetails;
    try {
      const initializeOrderDraftFn = httpsCallable(functions, "initializeOrderDraft");
      const draftResult = await initializeOrderDraftFn({
        shopId,
        specialInstructions,
        files: fileInputs.map((fi) => ({
          fileName: fi.file.name,
          fileType: fi.fileType,
          fileSizeBytes: fi.file.size,
          pageCount: fi.pageCount,
          color: fi.color,
          copies: fi.copies,
          doubleSided: fi.doubleSided,
        })),
      });
      const draftData = draftResult.data as { orderId?: string; verifiedPrice?: DocumentOrder['priceDetails'] };
      if (!draftData.orderId) {
        throw new Error("Order draft creation did not return an order ID.");
      }
      orderId = draftData.orderId;
      if (draftData.verifiedPrice) {
        verifiedPrice = draftData.verifiedPrice;
      }
    } catch (firestoreError: unknown) {
      addNotification({ message: `Failed to initialize order details: ${getErrorMessage(firestoreError)}. Please try again.`, type: 'error', targetUserId: userId });
      return { success: false };
    }

    const uploadedFiles: OrderFile[] = fileInputs.map(fi => ({
      fileName: fi.file.name,
      fileType: fi.fileType,
      fileStoragePath: `orders/${userId}/${orderId}/${fi.file.name}`,
      fileSizeBytes: fi.file.size,
      isFileDeleted: false,
      pageCount: fi.pageCount,
      color: fi.color,
      copies: fi.copies,
      doubleSided: fi.doubleSided,
    }));

    addNotification({ message: `Uploading ${totalFiles} file(s)...`, type: 'info', targetUserId: userId });

    const reportProgress = (fileIndex: number, fileProgress: number) => {
      fileProgressMap.set(fileIndex, fileProgress);
      let totalProgress = 0;
      for (let i = 0; i < totalFiles; i++) {
        totalProgress += fileProgressMap.get(i) ?? 0;
      }
      const overallProgress = Math.round((totalProgress / totalFiles) * 100);
      onProgress?.({
        currentFile: fileIndex + 1,
        totalFiles,
        fileProgress: Math.round(fileProgress * 100),
        overallProgress,
        fileName: fileInputs[fileIndex].file.name,
      });
    };

    // 2. Upload files in parallel batches of 3
    const uploadSingleFile = async (fi: typeof fileInputs[0], index: number): Promise<void> => {
      const filePath = `orders/${userId}/${orderId}/${fi.file.name}`;
      const fileRef = storageRef(storage, filePath);
      const uploadTask = uploadBytesResumable(fileRef, fi.file, {
        contentType: fi.file.type || 'application/octet-stream',
        customMetadata: { originalFileName: fi.file.name },
      });

      await new Promise<void>((resolve, reject) => {
        uploadTask.on('state_changed',
          (snapshot) => reportProgress(index, snapshot.bytesTransferred / snapshot.totalBytes),
          reject,
          () => { reportProgress(index, 1); resolve(); }
        );
      });
    };

    const CONCURRENCY = 3;
    try {
      for (let batchStart = 0; batchStart < totalFiles; batchStart += CONCURRENCY) {
        const batchEnd = Math.min(batchStart + CONCURRENCY, totalFiles);
        const batch = fileInputs.slice(batchStart, batchEnd).map((fi, i) => uploadSingleFile(fi, batchStart + i));
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
    const fileLabel = uploadedFiles.length === 1 ? uploadedFiles[0].fileName : `${uploadedFiles.length} files`;
    addNotification({ message: `Order #${orderId.slice(-6)} for ${fileLabel} (₹${verifiedPrice.totalPrice}) placed at ${targetShop.name}. Proceed to payment.`, orderId, type: 'info', targetUserId: userId });
    return { success: true, orderId };

  }, [addNotification, getShopById]);

  const updateOrderStatus = useCallback(async (orderId: string, status: OrderStatus, details?: { shopNotes?: string; paymentAttemptedAt?: string; actingUserType?: UserType }): Promise<DocumentOrder | undefined> => {
    const orderDocRef = doc(db, "orders", orderId);

    try {
      // Read current order state first, then validate and write.
      // NOTE: We intentionally avoid runTransaction here because Firebase SDK v11.x
      // has a known bug where transactions conflict with active onSnapshot listeners,
      // causing "INTERNAL ASSERTION FAILED: Unexpected state" errors with {"Fe":-1}.
      // A simple getDoc→validate→updateDoc is safe for order status updates since
      // only one shopkeeper processes each order (no concurrent writers).
      const orderSnap = await getDoc(orderDocRef);

      if (!orderSnap.exists()) {
        throw new Error(`Order #${orderId.slice(-6)} not found.`);
      }

      const currentOrderData = orderSnap.data() as DocumentOrder;
      const currentStatus = currentOrderData.status;

      // If status is changing, validate the transition
      if (status !== currentStatus) {
        const allowedTransitions = VALID_STATUS_TRANSITIONS[currentStatus];
        if (!allowedTransitions || !allowedTransitions.includes(status)) {
          throw new Error(
            `Invalid status transition: cannot move from "${currentStatus.replace(/_/g, ' ')}" to "${status.replace(/_/g, ' ')}".`
          );
        }
      }

      // Build update payload
      const updatePayload: Partial<DocumentOrder> = {};
      if (status !== currentStatus) updatePayload.status = status;
      if (details?.shopNotes !== undefined) updatePayload.shopNotes = details.shopNotes;
      if (details?.paymentAttemptedAt) updatePayload.paymentAttemptedAt = details.paymentAttemptedAt;
      if (status === OrderStatus.READY_FOR_PICKUP && !currentOrderData.pickupCode) {
        updatePayload.pickupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      }

      // Only write if there's something to update
      if (Object.keys(updatePayload).length === 0) {
        return currentOrderData;
      }

      // Simple updateDoc — no transaction needed for single-writer status updates
      await updateDoc(orderDocRef, updatePayload);

      const updatedOrderInstance = { ...currentOrderData, ...updatePayload };

      // NOTE: File cleanup is handled exclusively by the server-side onOrderStatusChange
      // Cloud Function trigger, which handles both legacy single-file and multi-file orders.
      // Removed client-side cleanup to avoid race conditions with the server trigger.

      // Send notifications
      if (updatedOrderInstance) {
        const targetShop = getShopById(updatedOrderInstance.shopId);
        // Use userName from the order document instead of fetching the user's profile.
        // Shopkeepers don't have Firestore permission to read other users' documents.
        const studentUserName = updatedOrderInstance.userName || 'Student';

        let studentMessage = `Order #${orderId.slice(-6)} (${updatedOrderInstance.fileName}) at ${targetShop?.name || 'shop'} is now ${status.replace(/_/g, ' ').toLowerCase()}.`;
        const shopMessage = `Order #${orderId.slice(-6)} (${updatedOrderInstance.fileName}) by ${studentUserName} is now ${status.replace(/_/g, ' ').toLowerCase()}.`;
        let type: NotificationMessage['type'] = 'info';

        if (status === OrderStatus.PENDING_APPROVAL) {
          type = 'success';
          addNotification({ message: shopMessage, orderId, type, targetShopId: updatedOrderInstance.shopId });
          addNotification({ message: studentMessage, orderId, type, targetUserId: updatedOrderInstance.userId });
        } else if (status === OrderStatus.PAYMENT_FAILED) {
          type = 'error';
          addNotification({ message: shopMessage, orderId, type, targetShopId: updatedOrderInstance.shopId });
          addNotification({ message: studentMessage, orderId, type, targetUserId: updatedOrderInstance.userId });
        } else if (details?.actingUserType === UserType.SHOP_OWNER) {
          if (status === OrderStatus.READY_FOR_PICKUP) {
            studentMessage += ` Pickup code: ${updatedOrderInstance.pickupCode}`;
            type = 'success';
          } else if (status === OrderStatus.CANCELLED) {
            studentMessage = `Order #${orderId.slice(-6)} has been cancelled by ${targetShop?.name || 'the shop'}.`;
            type = 'warning';
            if (details?.shopNotes) studentMessage += ` Reason: ${details.shopNotes}`;
          }
          addNotification({ message: studentMessage, orderId, type, targetUserId: updatedOrderInstance.userId });
        }
      }
      return updatedOrderInstance;
    } catch (err: unknown) {
      addNotification({ message: `Failed to update order status: ${getErrorMessage(err)}`, type: 'error' });
      return undefined;
    }
  }, [addNotification, getShopById]);

  const createPayout = useCallback(async (shopId: string, shopName: string, amount: number, adminNote?: string, otp?: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      return { success: false, message: "Only admins can manually create payouts." };
    }
    try {
      if (!otp) throw new Error("OTP is required to process manual payouts.");
      const idempotencyKey = `manual_${Date.now()}`;
      const adminCreatePayoutFunc = httpsCallable(functions, "adminCreatePayout");
      const result = await adminCreatePayoutFunc({ shopId, shopName, amount, adminNote, idempotencyKey, otp });
      addNotification({ message: `Manual payout processed for ${shopName}.`, type: 'success', targetShopId: shopId });
      return { success: true, message: (result.data as { message?: string }).message };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to create payout: ${message}`, type: 'error', targetShopId: shopId });
      return { success: false, message };
    }
  }, [currentUser, addNotification]);

  const approvePayout = useCallback(async (payoutId: string, otp: string, adminNote?: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      return { success: false, message: "Only admins can approve payouts." };
    }
    try {
      const func = httpsCallable(functions, "approvePayoutRequest");
      await func({ payoutId, otp, adminNote });
      addNotification({ message: `Payout marked as paid.`, type: 'success' });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [currentUser, addNotification]);

  const rejectPayout = useCallback(async (payoutId: string, otp: string, adminNote?: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      return { success: false, message: "Only admins can reject payouts." };
    }
    try {
      const func = httpsCallable(functions, "rejectPayoutRequest");
      await func({ payoutId, otp, adminNote });
      addNotification({ message: `Payout request rejected and reversed safely.`, type: 'success' });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [currentUser, addNotification]);

  const cancelPayout = useCallback(async (payoutId: string, otp: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      return { success: false, message: "Only admins can cancel payouts." };
    }
    try {
      const func = httpsCallable(functions, "cancelPayout");
      await func({ payoutId, otp });
      addNotification({ message: `Payout cancelled and reversed safely.`, type: 'success' });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [currentUser, addNotification]);

  const requestPayout = useCallback(async (shopId: string, shopName: string, amount: number, shopOwnerNote?: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.SHOP_OWNER) {
      return { success: false, message: "Only shop owners can request payouts." };
    }
    if (amount <= 0) {
      return { success: false, message: "Amount must be greater than 0." };
    }
    try {
      addNotification({ message: `Submitting payout request...`, type: 'info' });
      const requestPayoutFunc = httpsCallable(functions, "requestPayout");
      // V-03: Provide client-side idempotency key to prevent double-spending
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await requestPayoutFunc({ shopId, shopName, amount, shopOwnerNote, requestId });
      addNotification({ message: `Payout request of ₹${amount.toFixed(2)} submitted. Admin will review and process it.`, type: 'success', targetShopId: shopId });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to request payout: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification]);

  const confirmPayout = useCallback(async (payoutId: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.SHOP_OWNER) {
      return { success: false, message: "Only shop owners can confirm payouts." };
    }
    try {
      const func = httpsCallable(functions, "confirmShopPayout");
      await func({ payoutId });
      addNotification({ message: `Payout confirmed! Thank you.`, type: 'success', targetUserId: currentUser.id });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [currentUser, addNotification]);

  const disputePayout = useCallback(async (payoutId: string, shopOwnerNote: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.SHOP_OWNER) {
      return { success: false, message: "Only shop owners can dispute payouts." };
    }
    try {
      if (!shopOwnerNote || !shopOwnerNote.trim()) {
        return { success: false, message: "Dispute note cannot be empty." };
      }
      const func = httpsCallable(functions, "disputeShopPayout");
      await func({ payoutId, disputeNote: shopOwnerNote });
      addNotification({ message: `Payout disputed. Admin has been notified.`, type: 'warning', targetUserId: currentUser.id });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [currentUser, addNotification]);

  const markNotificationAsRead = useCallback((notificationId: string) => {
    if (notificationId.startsWith('local_')) {
      // Local notification — update local state
      setLocalNotifications(prev => prev.map(n => (n.id === notificationId ? { ...n, read: true } : n)));
    } else {
      // Firestore notification — update in database (onSnapshot will propagate the change)
      updateDoc(doc(db, "notifications", notificationId), { read: true }).catch(err => {
        debugLog("[AppContext] Failed to mark notification as read:", err);
      });
    }
  }, []);

  const getNotificationsForCurrentUser = useCallback(() => {
    // Firestore listener already filters by recipientUserId for the current user.
    // Local notifications are session-scoped for the current user by nature.
    // Both are merged in the `notifications` useMemo.
    return notifications;
  }, [notifications]);

  const getOrdersForCurrentUser = useCallback(() => {
    return orders;
  }, [orders]);

  // Admin shop management functions
  const approveShop = useCallback(async (shopId: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      return { success: false, message: "Only admins can approve shops." };
    }
    try {
      const approveShopFn = httpsCallable(functions, 'approveShopRegistration');
      const result = await approveShopFn({ shopId });
      const data = result.data as { success?: boolean; message?: string };
      if (data.success) {
        addNotification({ message: `Shop approved successfully.`, type: 'success' });
      }
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to approve shop: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification]);

  const rejectShop = useCallback(async (shopId: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      return { success: false, message: "Only admins can reject shops." };
    }
    try {
      const rejectShopFn = httpsCallable(functions, 'rejectShopRegistration');
      const result = await rejectShopFn({ shopId });
      const data = result.data as { success?: boolean; message?: string };
      addNotification({ message: data.message || `Shop rejected and removed.`, type: 'info' });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to reject shop: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification]);

  const archiveShop = useCallback(async (shopId: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      return { success: false, message: "Only admins can archive shops." };
    }
    try {
      const shopRef = doc(db, "shops", shopId);
      await updateDoc(shopRef, { isArchived: true, isOpen: false });
      const shop = shops.find(s => s.id === shopId);
      addNotification({ message: `Shop "${shop?.name || shopId}" has been archived.`, type: 'info' });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to archive shop: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification, shops]);

  const unarchiveShop = useCallback(async (shopId: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      return { success: false, message: "Only admins can unarchive shops." };
    }
    try {
      const shopRef = doc(db, "shops", shopId);
      await updateDoc(shopRef, { isArchived: false });
      const shop = shops.find(s => s.id === shopId);
      addNotification({ message: `Shop "${shop?.name || shopId}" has been unarchived.`, type: 'success' });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to unarchive shop: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification, shops]);

  const shopInitiateRefund = useCallback(async (ticketId: string, orderId: string, reason: string): Promise<{ success: boolean; message?: string }> => {
    try {
      if (!currentUser || currentUser.type !== UserType.SHOP_OWNER) throw new Error('Unauthorized');

      const shopInitiateRefundFn = httpsCallable(functions, 'shopInitiateRefund');
      await shopInitiateRefundFn({ ticketId, orderId, reason });

      addNotification({ message: `Refund request initiated successfully.`, type: 'success' });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to initiate refund: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification]);

  const escalateTicketToAdmin = useCallback(async (ticketId: string, reason: string): Promise<{ success: boolean; message?: string }> => {
    try {
      if (!currentUser || currentUser.type !== UserType.STUDENT) throw new Error('Unauthorized');

      const escalateTicketToAdminFn = httpsCallable(functions, 'escalateTicketToAdmin');
      await escalateTicketToAdminFn({ ticketId, reason });

      addNotification({ message: `Ticket escalated to Admin successfully.`, type: 'success' });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to escalate ticket: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification]);

  // Account Orchestration Flow (OTP protected actions)
  const requestAccountActionOTP = useCallback(async (actionId: string): Promise<{ success: boolean; message?: string }> => {
    try {
      const func = httpsCallable(functions, "requestAccountActionOTP");
      await func({ actionId });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, []);

  const executeAccountAction = useCallback(async (action: string, otp: string, targetUid?: string, targetShopId?: string): Promise<{ success: boolean; message?: string }> => {
    try {
      const executeFunc = httpsCallable(functions, "executeAccountAction");
      await executeFunc({ action, otp, targetUid, targetShopId });
      // If deleting own account, log out
      if (action === "DELETE_OWN_ACCOUNT") {
        await signOut(auth);
      }
      addNotification({ message: 'Action completed successfully.', type: 'success' });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to complete action: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [addNotification]);

  // Approved shops — only approved and non-archived shops visible to students
  const approvedShops = useMemo(() => shops.filter(s => s.isApproved && !s.isArchived), [shops]);

  // ---- ARCHIVED SHOP DETECTION (in onAuthStateChanged handler) ----
  // Detect if current signed-in shop owner has an archived shop.
  // This runs whenever currentUser or shops change.
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

  // ---- REACTIVATION REQUESTS LISTENER (admin-only) ----
  useEffect(() => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      setReactivationRequests([]);
      return;
    }

    let fallbackUnsub: (() => void) | null = null;

    const reactivationQuery = query(
      collection(db, 'reactivationRequests'),
      orderBy('requestedAt', 'desc'),
      limit(100)
    );

    const unsub = onSnapshot(reactivationQuery, (snap) => {
      const requests: ReactivationRequest[] = snap.docs.map(d => ({ id: d.id, ...d.data() } as ReactivationRequest));
      setReactivationRequests(requests);
    }, (err) => {
      if (isExpectedPermissionLoss(err)) return;
      debugLog('[AppContext] Reactivation requests listener error:', err);
      // Fallback: try without orderBy in case index isn't ready
      const fallbackQuery = query(collection(db, 'reactivationRequests'), limit(100));
      fallbackUnsub?.();
      fallbackUnsub = onSnapshot(fallbackQuery, (snap) => {
        const requests: ReactivationRequest[] = snap.docs.map(d => ({ id: d.id, ...d.data() } as ReactivationRequest));
        requests.sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());
        setReactivationRequests(requests);
      }, (error) => {
        debugLog('[AppContext] Reactivation fallback listener error:', error);
      });
    });

    return () => {
      unsub();
      fallbackUnsub?.();
    };
  }, [currentUser]);

  // ---- TICKETS STATE + LISTENER ----
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [reports, setReports] = useState<EarningsReport[]>([]);
  const [refundRequests, setRefundRequests] = useState<RefundRequest[]>([]);

  // ---- REFUND REQUESTS LISTENER ----
  useEffect(() => {
    if (!currentUser) { setRefundRequests([]); return; }

    let q;
    if (currentUser.type === UserType.ADMIN) {
      q = query(collection(db, 'refundRequests'), where('status', 'in', ['ESCALATED_TO_ADMIN', 'AUTO_ESCALATED', 'PENDING_SHOP', 'APPROVED_BY_SHOP']), limit(200));
    } else if (currentUser.type === UserType.SHOP_OWNER) {
      q = query(collection(db, 'refundRequests'), where('shopId', '==', currentUser.shopId), limit(100));
    } else {
      q = query(collection(db, 'refundRequests'), where('studentId', '==', currentUser.id), limit(100));
    }

    const unsub = onSnapshot(q, (snap) => {
      const requests = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as RefundRequest));
      setRefundRequests(requests.sort((a, b) => b.studentRequestedAt.localeCompare(a.studentRequestedAt)));
    }, err => {
      if (!isExpectedPermissionLoss(err)) {
        debugLog('Refund Requests listener fallback:', err);
      }
    });

    return () => unsub();
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) { setTickets([]); return; }

    let unsubTickets: (() => void) | null = null;
    let unsubTicketsAssigned: (() => void) | null = null;
    let isCleaned = false;

    const subscribeTickets = (useFallback: boolean) => {
      if (isCleaned) return;

      if (currentUser.type === UserType.SHOP_OWNER && currentUser.shopId) {
        // Break OR query to prevent Firestore static analysis crash
        const qRaised = useFallback
          ? query(collection(db, 'tickets'), where('raisedBy', '==', currentUser.id), limit(100))
          : query(collection(db, 'tickets'), where('raisedBy', '==', currentUser.id), orderBy('updatedAt', 'desc'), limit(100));

        const qAssigned = useFallback
          ? query(collection(db, 'tickets'), where('shopId', '==', currentUser.shopId), limit(100))
          : query(collection(db, 'tickets'), where('shopId', '==', currentUser.shopId), orderBy('updatedAt', 'desc'), limit(100));

        let raisedList: SupportTicket[] = [];
        let assignedList: SupportTicket[] = [];

        const updateMerged = () => {
          const merged = [...raisedList, ...assignedList];
          const unique = Array.from(new Map(merged.map(item => [item.id, item])).values());
          unique.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
          setTickets(unique);
        };

        const handleFallback = (err: unknown) => {
          if (isExpectedPermissionLoss(err)) return;
          debugLog('[AppContext] Tickets listener error:', err);
          const errorMessage = typeof err === 'object' && err && 'message' in err
            ? String((err as { message?: unknown }).message ?? '')
            : '';
          if (!useFallback && errorMessage.includes('index')) {
            unsubTickets?.();
            unsubTicketsAssigned?.();
            unsubTickets = null;
            unsubTicketsAssigned = null;
            subscribeTickets(true);
          }
        };

        unsubTickets = onSnapshot(qRaised, (snap) => {
          raisedList = snap.docs.map(d => ({ id: d.id, ...d.data() } as SupportTicket));
          updateMerged();
        }, handleFallback);

        unsubTicketsAssigned = onSnapshot(qAssigned, (snap) => {
          assignedList = snap.docs.map(d => ({ id: d.id, ...d.data() } as SupportTicket));
          updateMerged();
        }, handleFallback);

      } else {
        let ticketsQuery;
        if (currentUser.type === UserType.ADMIN) {
          ticketsQuery = useFallback
            ? query(collection(db, 'tickets'), limit(100))
            : query(collection(db, 'tickets'), orderBy('updatedAt', 'desc'), limit(100));
        } else {
          ticketsQuery = useFallback
            ? query(collection(db, 'tickets'), where('raisedBy', '==', currentUser.id), limit(100))
            : query(collection(db, 'tickets'), where('raisedBy', '==', currentUser.id), orderBy('updatedAt', 'desc'), limit(100));
        }

        unsubTickets = onSnapshot(ticketsQuery, (snap) => {
          const ticketList: SupportTicket[] = snap.docs.map(d => ({ id: d.id, ...d.data() } as SupportTicket));
          ticketList.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
          setTickets(ticketList);
        }, (err) => {
          if (isExpectedPermissionLoss(err)) return;
          debugLog('[AppContext] Tickets listener error:', err);
          if (!useFallback && err?.message?.includes('index')) {
            debugLog('[AppContext] Falling back to simple tickets query (index not ready)');
            unsubTickets?.();
            unsubTickets = null;
            subscribeTickets(true);
          }
        });
      }
    };

    subscribeTickets(false);

    // Reports listener (admin only)
    let unsubReports: (() => void) | undefined;
    if (currentUser.type === UserType.ADMIN) {
      const reportsQuery = query(collection(db, 'reports'), orderBy('generatedAt', 'desc'), limit(50));
      unsubReports = onSnapshot(reportsQuery, (snap) => {
        const reportList: EarningsReport[] = snap.docs.map(d => ({ id: d.id, ...d.data() } as EarningsReport));
        setReports(reportList);
      });
    }

    return () => {
      isCleaned = true;
      unsubTickets?.();
      unsubTicketsAssigned?.();
      unsubReports?.();
    };
  }, [currentUser]);

  // ---- BANK DETAILS FUNCTIONS ----
  const getBankDetails = useCallback(async (shopId: string): Promise<BankDetails | null> => {
    try {
      const bankDocRef = doc(db, 'shops', shopId, 'private', 'bankDetails');
      const snap = await getDoc(bankDocRef);
      if (snap.exists()) return snap.data() as BankDetails;
      return null;
    } catch (err) {
      debugLog('[AppContext] getBankDetails error:', err);
      return null;
    }
  }, []);

  const saveBankDetails = useCallback(async (shopId: string, details: BankDetails): Promise<{ success: boolean; message?: string }> => {
    try {
      const bankDocRef = doc(db, 'shops', shopId, 'private', 'bankDetails');
      const existingSnap = await getDoc(bankDocRef);
      const existingDetails = existingSnap.exists() ? existingSnap.data() as BankDetails : null;

      const cleanDetails: BankDetails = { ...details };
      if (currentUser?.type !== UserType.ADMIN) {
        delete cleanDetails.isVerified;
        delete cleanDetails.verifiedAt;

        // Preserve verification metadata on owner edits so the rules don't reject
        // the write for touching admin-managed fields.
        if (existingDetails?.isVerified !== undefined) {
          cleanDetails.isVerified = existingDetails.isVerified;
        }
        if (existingDetails?.verifiedAt) {
          cleanDetails.verifiedAt = existingDetails.verifiedAt;
        }
      }

      // Merge owner edits so admin-managed verification fields are preserved.
      // A full replace can implicitly delete fields like `verifiedBy`, which the
      // private-doc rules correctly block shop owners from mutating.
      await setDoc(bankDocRef, { ...cleanDetails, updatedAt: new Date().toISOString() }, { merge: true });

      // Log the edit
      await addDoc(collection(db, 'shops', shopId, 'bankAccessLogs'), {
        userId: currentUser?.id || 'unknown',
        userRole: currentUser?.type || 'unknown',
        action: 'EDIT',
        timestamp: new Date().toISOString(),
      });
      addNotification({ message: 'Bank details saved securely.', type: 'success', targetShopId: shopId });
      return { success: true };
    } catch (err) {
      debugLog('[AppContext] saveBankDetails error:', err);
      return { success: false, message: getErrorMessage(err) };
    }
  }, [currentUser, addNotification]);

  const getPaymentConfig = useCallback(async (shopId: string): Promise<PaymentConfiguration | null> => {
    try {
      const configDocRef = doc(db, 'shops', shopId, 'private', 'paymentConfig');
      const snap = await getDoc(configDocRef);
      if (snap.exists()) return snap.data() as PaymentConfiguration;
      return null;
    } catch (err) {
      debugLog('[AppContext] getPaymentConfig error:', err);
      return null;
    }
  }, []);

  const verifyBankDetails = useCallback(async (shopId: string): Promise<{ success: boolean; message?: string }> => {
    try {
      const bankDocRef = doc(db, 'shops', shopId, 'private', 'bankDetails');
      await updateDoc(bankDocRef, { isVerified: true, verifiedAt: new Date().toISOString() });
      await addDoc(collection(db, 'shops', shopId, 'bankAccessLogs'), {
        userId: currentUser?.id || 'unknown',
        userRole: currentUser?.type || 'unknown',
        action: 'VERIFY',
        timestamp: new Date().toISOString(),
      });
      addNotification({ message: 'Bank details verified.', type: 'success', targetShopId: shopId });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [currentUser, addNotification]);

  const logBankAccess = useCallback(async (shopId: string, action: 'VIEW' | 'EDIT' | 'VERIFY') => {
    try {
      await addDoc(collection(db, 'shops', shopId, 'bankAccessLogs'), {
        userId: currentUser?.id || 'unknown',
        userRole: currentUser?.type || 'unknown',
        action,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      debugLog('[AppContext] logBankAccess error:', err);
    }
  }, [currentUser]);

  // ---- TICKET FUNCTIONS ----
  const createTicket = useCallback(async (ticketData: { subject: string; category: TicketCategory; description: string; relatedOrderId?: string; attachmentFiles?: File[] }): Promise<{ success: boolean; ticketId?: string; message?: string }> => {
    if (!currentUser) return { success: false, message: 'Not logged in' };

    // Guard: shopkeepers must have shopId resolved before creating tickets
    if (currentUser.type === UserType.SHOP_OWNER && !currentUser.shopId) {
      return { success: false, message: 'Shop data is still loading. Please wait a moment and try again.' };
    }

    try {
      const createTicketFn = httpsCallable(functions, 'createSupportTicket');
      const callableResult = await createTicketFn({
        subject: ticketData.subject.trim(),
        category: ticketData.category,
        description: ticketData.description.trim(),
        relatedOrderId: ticketData.relatedOrderId || undefined,
      });
      const callableData = callableResult.data as { success?: boolean; ticketId?: string };
      const ticketId = callableData.ticketId;

      if (!ticketId) {
        throw new Error('Ticket creation did not return a ticket ID.');
      }

      // 2. Upload attachment files if any
      const attachmentPaths: string[] = [];
      if (ticketData.attachmentFiles && ticketData.attachmentFiles.length > 0) {
        for (const file of ticketData.attachmentFiles.slice(0, 3)) { // max 3 files
          if (file.size > 5 * 1024 * 1024) continue; // skip files > 5MB
          // Prefix with unique ID to prevent filename collisions
          const uniquePrefix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const path = `tickets/${ticketId}/${uniquePrefix}_${file.name}`;
          const fileRef = storageRef(storage, path);
          await uploadBytesResumable(fileRef, file);
          attachmentPaths.push(path);
        }
      }

      // 3. Finalize the attachment paths server-side so the client cannot forge them.
      if (attachmentPaths.length > 0) {
        const attachTicketFilesFn = httpsCallable(functions, 'attachTicketFiles');
        await attachTicketFilesFn({ ticketId, attachmentPaths });
      }
      addNotification({ message: `Ticket "${ticketData.subject}" submitted. We'll respond within 24 hours.`, type: 'success', targetUserId: currentUser.id });
      return { success: true, ticketId };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      // Check if the ticket doc was already created before the failure
      // (e.g., attachment upload or finalization failed)
      if (message.includes('attach') || message.includes('upload')) {
        addNotification({ message: `Ticket created but attachment upload failed. You can re-attach files later.`, type: 'warning' });
        return { success: true, message: 'Ticket created without attachments.' };
      }
      addNotification({ message: `Failed to create ticket: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification]);

  const addTicketMessage = useCallback(async (ticketId: string, message: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser) return { success: false, message: 'Not logged in' };

    try {
      const ticketRef = doc(db, 'tickets', ticketId);
      const ticketSnap = await getDoc(ticketRef);
      if (!ticketSnap.exists()) return { success: false, message: 'Ticket not found' };
      const ticketData = ticketSnap.data() as SupportTicket;

      const now = new Date().toISOString();
      const newMessage: TicketMessage = {
        id: `msg_${Date.now()}`,
        senderId: currentUser.id,
        senderName: currentUser.name || 'Unknown',
        senderType: currentUser.type,
        message,
        timestamp: now,
      };

      const existingMessages = Array.isArray(ticketData.messages) ? ticketData.messages : [];
      const updatedMessages = [...existingMessages, newMessage];

      const updateData: Partial<SupportTicket> = {
        messages: updatedMessages,
        updatedAt: now,
      };

      if (currentUser.type === UserType.ADMIN) {
        updateData.adminLastRepliedAt = now;
        if (ticketData.status === TicketStatus.OPEN) {
          updateData.status = TicketStatus.IN_REVIEW;
          const statusChange: TicketStatusChange = { from: ticketData.status, to: TicketStatus.IN_REVIEW, changedBy: currentUser.id, changedByName: currentUser.name || 'Admin', timestamp: now, note: 'Admin replied' };
          const existingHistory = Array.isArray(ticketData.statusHistory) ? ticketData.statusHistory : [];
          updateData.statusHistory = [...existingHistory, statusChange];
        }
      } else if (currentUser.type === UserType.SHOP_OWNER) {
        // Shop owner replies must use shopLastRepliedAt — matching the Firestore rules allowlist
        updateData.shopLastRepliedAt = now;
      } else {
        // STUDENT
        updateData.raiserLastRepliedAt = now;
      }

      await updateDoc(ticketRef, updateData);
      return { success: true };
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      addNotification({ message: `Failed to send reply: ${errorMessage}`, type: 'error' });
      return { success: false, message: errorMessage };
    }
  }, [currentUser, addNotification]);

  const updateTicketStatus = useCallback(async (ticketId: string, newStatus: TicketStatus, note?: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser) return { success: false, message: 'Not logged in' };

    try {
      const ticketRef = doc(db, 'tickets', ticketId);
      const ticketSnap = await getDoc(ticketRef);
      if (!ticketSnap.exists()) return { success: false, message: 'Ticket not found' };
      const ticketData = ticketSnap.data() as SupportTicket;

      // Client-side state-machine guard (mirrors Firestore rules)
      const validStatuses = Object.values(TicketStatus);
      if (!validStatuses.includes(newStatus)) {
        return { success: false, message: `Invalid target status: ${newStatus}` };
      }
      if (currentUser.type !== UserType.ADMIN) {
        // Only ADMIN can set RESOLVED or IN_REVIEW
        if (newStatus === TicketStatus.RESOLVED || newStatus === TicketStatus.IN_REVIEW) {
          return { success: false, message: 'Only admins can set this status.' };
        }
        // Non-admin may only close an open or in-review ticket
        if (newStatus === TicketStatus.CLOSED &&
            ticketData.status !== TicketStatus.OPEN &&
            ticketData.status !== TicketStatus.IN_REVIEW) {
          return { success: false, message: 'Ticket cannot be closed from its current state.' };
        }
      }

      const now = new Date().toISOString();
      const statusChange: Record<string, unknown> = {
        from: ticketData.status,
        to: newStatus,
        changedBy: currentUser.id,
        changedByName: currentUser.name || 'Unknown',
        timestamp: now,
      };

      if (note) {
        statusChange.note = note;
      }

      const existingHistory = Array.isArray(ticketData.statusHistory) ? ticketData.statusHistory : [];

      await updateDoc(ticketRef, {
        status: newStatus,
        statusHistory: [...existingHistory, statusChange],
        updatedAt: now,
      });

      addNotification({ message: `Ticket "${ticketData.subject}" status changed to ${newStatus.replace(/_/g, ' ')}.`, type: 'info', targetUserId: ticketData.raisedBy });
      return { success: true };
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      addNotification({ message: `Failed to update ticket: ${errorMessage}`, type: 'error' });
      return { success: false, message: errorMessage };
    }
  }, [currentUser, addNotification]);

  const contextValue = useMemo(() => ({
    currentUser, isLoadingAuth, pendingFirebaseProfileCreationUser, setPendingFirebaseProfileCreationUser,
    signInWithGoogle, signUpWithEmailPassword, signInWithEmailAndPassword: signInWithEmailAndPasswordInternal,
    completeStudentProfileCreation, completeShopOwnerProfileCreation, checkReturningShopOwner, logoutUser,
    shops, isLoadingShops, getShopById, registerShop, updateShopSettings,
    orders, allOrders, getOrdersForCurrentUser,
    notifications,
    addOrder, updateOrderStatus,
    addNotification, markNotificationAsRead, getNotificationsForCurrentUser,
    currentView, navigateTo, goBack, upgradeToStudentPass, cancelStudentPass,
    payouts, createPayout, approvePayout, rejectPayout, cancelPayout, requestPayout, confirmPayout, disputePayout,
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
        await httpsCallable(functions, 'createRefundRequest')({ orderId, reason });
        return { success: true };
      } catch (err) {
        return { success: false, message: getErrorMessage(err) };
      }
    },
    respondToRefundRequest: async (requestId: string, approved: boolean, shopResponse?: string) => {
      try {
        await httpsCallable(functions, 'respondToRefundRequest')({ requestId, approved, shopResponse });
        return { success: true };
      } catch (err) {
        return { success: false, message: getErrorMessage(err) };
      }
    },
    escalateRefundRequest: async (requestId: string) => {
      try {
        await httpsCallable(functions, 'escalateRefundRequest')({ requestId });
        return { success: true };
      } catch (err) {
        return { success: false, message: getErrorMessage(err) };
      }
    },
    resolveRefundRequest: async (requestId: string, action: 'APPROVE' | 'DENY', otp: string, adminNote?: string) => {
      try {
        await httpsCallable(functions, 'resolveRefundRequest')({ requestId, action, otp, adminNote });
        return { success: true };
      } catch (err) {
        return { success: false, message: getErrorMessage(err) };
      }
    },
    syncRefundHistory: async (orderId: string) => {
      try {
        const res = await httpsCallable(functions, 'syncRefundHistory')({ orderId });
        const data = res.data as { success: boolean; count: number; refunds: import('../types').RazorpayRefund[]; message?: string };
        return data;
      } catch (err) {
        return { success: false, count: 0, refunds: [], message: getErrorMessage(err) };
      }
    },
    ordersLimit, payoutsLimit, notificationsLimit, shopsLimit,
    loadMoreOrders, loadMorePayouts, loadMoreNotifications, loadMoreShops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [
    currentUser, isLoadingAuth, pendingFirebaseProfileCreationUser,
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
