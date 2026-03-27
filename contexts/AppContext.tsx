import React, { createContext, useState, useContext, useCallback, useMemo, ReactNode, useEffect, useRef } from 'react';
import { DocumentOrder, OrderFile, NotificationMessage, OrderStatus, User, UserType, ShopProfile, ShopPricing, PayoutMethod, AppView, ShopPayout, PayoutStatus, PrintColor } from '../types';
import { DEFAULT_SHOP_PRICING, ADMIN_EMAILS } from '../constants';
import {
  auth,
  db,
  storage,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword as firebaseSignInWithEmailAndPassword,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
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
  onSnapshot,
  runTransaction,
  enableNetwork
} from '../firebase';

import { Capacitor } from '@capacitor/core';

// Helper to safely extract error messages from unknown error types
const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'An unexpected error occurred.';
};

// Pricing utilities — imported from dedicated module for clean HMR
import { calculateBaseFee, calculateOrderPrice, calculateMultiFileOrderPrice } from '../utils/pricing';
export { calculateBaseFee, calculateOrderPrice, calculateMultiFileOrderPrice };

// Push notification registration for native mobile
import { registerPushNotifications, unregisterPushNotifications } from '../utils/pushNotifications';

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
  logoutUser: () => Promise<void>;
  upgradeToStudentPass: () => Promise<{ success: boolean; message?: string }>;
  cancelStudentPass: () => Promise<{ success: boolean; message?: string }>;

  shops: ShopProfile[];
  isLoadingShops: boolean;
  getShopById: (shopId: string) => ShopProfile | undefined;
  registerShop: (shopName: string, shopAddress: string, ownerUserId: string, initialPricing: ShopPricing) => Promise<ShopProfile | null>;
  updateShopSettings: (shopId: string, newSettings: { pricing: ShopPricing; isOpen: boolean; payoutMethods?: PayoutMethod[] }) => Promise<void>;

  orders: DocumentOrder[];
  allOrders: DocumentOrder[]; // Admin: all orders across all shops
  getOrdersForCurrentUser: () => DocumentOrder[];

  notifications: NotificationMessage[];
  addOrder: (orderData: {
    userId: string;
    shopId: string;
    fileInputs: { file: File; fileType: string; pageCount: number; color: PrintColor; copies: number; doubleSided: boolean }[];
  }) => Promise<{ success: boolean, orderId?: string }>;
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
  createPayout: (shopId: string, shopName: string, amount: number, adminNote?: string) => Promise<{ success: boolean; message?: string }>;
  requestPayout: (shopId: string, shopName: string, amount: number, shopOwnerNote?: string) => Promise<{ success: boolean; message?: string }>;
  markPayoutPaid: (payoutId: string) => Promise<{ success: boolean; message?: string }>;
  confirmPayout: (payoutId: string) => Promise<{ success: boolean; message?: string }>;
  disputePayout: (payoutId: string, shopOwnerNote: string) => Promise<{ success: boolean; message?: string }>;

  // Admin shop management
  approveShop: (shopId: string) => Promise<{ success: boolean; message?: string }>;
  rejectShop: (shopId: string) => Promise<{ success: boolean; message?: string }>;
  deleteShopAndOwner: (shopId: string, ownerUserId: string) => Promise<{ success: boolean; message?: string }>;
  archiveShop: (shopId: string) => Promise<{ success: boolean; message?: string }>;
  unarchiveShop: (shopId: string) => Promise<{ success: boolean; message?: string }>;
  approvedShops: ShopProfile[]; // Only approved & non-archived shops (for student view)

  // Shop owner self-delete
  deleteOwnShopAccount: () => Promise<{ success: boolean; message?: string }>;
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
  [OrderStatus.PAYMENT_FAILED]: [OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED], // Can retry or cancel
};

// Helper function to clean payout methods array
const cleanPayoutMethods = (methods?: PayoutMethod[]): PayoutMethod[] => {
  if (!methods) return [];
  return methods.filter(method => method !== null && method !== undefined);
};

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUserInternal] = useState<User | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState<boolean>(true);
  const [pendingFirebaseProfileCreationUser, setPendingFirebaseProfileCreationUser] = useState<FirebaseUser | null>(null);

  // Stable refs to break the dependency cycle: shops → addNotification → shops useEffect
  const addNotificationRef = useRef<(notification: Omit<NotificationMessage, 'id' | 'timestamp' | 'read'>) => void>(() => { });
  const shopsRef = useRef<ShopProfile[]>([]);
  const currentUserRef = useRef<User | null>(null);

  const [shops, setShops] = useState<ShopProfile[]>([]);
  const [isLoadingShops, setIsLoadingShops] = useState<boolean>(true);
  const [orders, setOrders] = useState<DocumentOrder[]>([]);
  const [allOrders, setAllOrders] = useState<DocumentOrder[]>([]); // Admin: all orders
  const [payouts, setPayouts] = useState<ShopPayout[]>([]);
  const [studentPassHolders, setStudentPassHolders] = useState<{ id: string; name?: string; email?: string; studentPassActivatedAt?: string; studentPassPaymentId?: string }[]>([]);
  const [firestoreNotifications, setFirestoreNotifications] = useState<NotificationMessage[]>([]);
  const [localNotifications, setLocalNotifications] = useState<NotificationMessage[]>([]);
  const [currentView, setCurrentView] = useState<AppView>('landing');
  const viewHistoryRef = useRef<AppView[]>([]);

  // Merged notifications: Firestore (persistent, cross-user) + local (session-only toasts)
  const notifications = useMemo(() => {
    return [...localNotifications, ...firestoreNotifications]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [localNotifications, firestoreNotifications]);

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

    // Determine the recipient for Firestore persistence
    // Use shopsRef to avoid depending on shops state (which would cause re-render cycles)
    let recipientUserId = notificationData.targetUserId;

    // Route 'ADMIN' notifications to actual admin user IDs
    if (recipientUserId === 'ADMIN') {
      // Find admin users from the current user list or fall back
      // Admin emails are known at build time — look up their UIDs from Firestore
      recipientUserId = undefined; // Clear the placeholder
      // Admin notifications: persist for each known admin by targeting all admin emails
      // Since we can't reliably resolve UIDs without a query, create a local notification instead
      // The server-side Cloud Functions handle critical admin notifications via recipientUserId
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

    if (recipientUserId) {
      // Persist to Firestore — the onSnapshot listener will deliver it to the recipient
      const firestoreNotif = {
        ...notificationData,
        recipientUserId,
        timestamp,
        read: false,
      };
      addDoc(collection(db, "notifications"), firestoreNotif).catch(err => {
        console.error("[AppContext] Failed to persist notification:", err);
      });
    } else {
      // Local-only notification (error toasts, confirmations for the acting user)
      const localNotif: NotificationMessage = {
        ...notificationData,
        id: `local_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        timestamp,
        read: false,
      };
      setLocalNotifications(prev => [localNotif, ...prev].slice(0, 20));
    }
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

  // Register for push notifications when user logs in (native platforms only)
  useEffect(() => {
    if (currentUser?.id) {
      registerPushNotifications(currentUser.id, (title, body) => {
        // Show in-app notification when push arrives while app is in foreground
        addNotificationRef.current({ message: body || title, type: 'info' });

        // Force Firestore to reconnect — the push means server data changed,
        // but the WebSocket may still be serving cached data
        if (Capacitor.isNativePlatform()) {
          console.log('[AppContext] Push received — kicking Firestore to pick up changes');
          enableNetwork(db).catch(() => { });
        }
      });
    }
    return () => {
      if (currentUser?.id) {
        unregisterPushNotifications(currentUser.id);
      }
    };
  }, [currentUser?.id]);

  // Reconnect Firestore when app resumes from background (native + web)
  // Android WebView's WebSocket to Firestore goes stale very easily — even brief
  // background periods cause onSnapshot listeners to silently serve cached data.
  // On native: always reconnect on resume (no threshold) + periodic heartbeat
  // On web: reconnect after 5s background (avoid Razorpay popup false triggers)
  useEffect(() => {
    let lastBackgroundedAt = 0;
    let isAppActive = true;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    const isNativePlatform = Capacitor.isNativePlatform();
    // Web needs a threshold to avoid reconnecting during Razorpay popup; native doesn't
    const MIN_BACKGROUND_MS = isNativePlatform ? 0 : 5000;

    const reconnectFirestore = (reason: string) => {
      const backgroundDuration = Date.now() - lastBackgroundedAt;
      if (lastBackgroundedAt > 0 && backgroundDuration < MIN_BACKGROUND_MS) {
        console.log(`[AppContext] App resumed after ${backgroundDuration}ms — skipping reconnect (${reason})`);
        return;
      }
      // Only call enableNetwork — do NOT call disableNetwork first.
      // The disableNetwork→enableNetwork cycle corrupts Firestore's internal state
      // when onSnapshot listeners are active, causing:
      //   INTERNAL ASSERTION FAILED: Unexpected state {"Fe":-1}
      // enableNetwork alone is safe: it's a no-op when connected, and gently
      // reconnects stale WebSockets without disrupting active listeners.
      console.log(`[AppContext] Refreshing Firestore connection — ${reason}`);
      enableNetwork(db)
        .then(() => console.log('[AppContext] Firestore connection refreshed'))
        .catch(err => {
          console.warn('[AppContext] Firestore enableNetwork failed:', err);
        });
    };

    // On native, run a periodic heartbeat to keep Firestore listeners alive
    // This cycles the network connection every 30s while the app is in the foreground
    const startHeartbeat = () => {
      if (heartbeatInterval || !isNativePlatform) return;
      heartbeatInterval = setInterval(() => {
        if (isAppActive) {
          console.log('[AppContext] Heartbeat — refreshing Firestore connection');
          enableNetwork(db).catch(() => { });
        }
      }, 30_000); // Every 30 seconds
    };

    const stopHeartbeat = () => {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    };

    let nativeCleanup: (() => void) | undefined;

    if (isNativePlatform) {
      // Start heartbeat immediately on native
      startHeartbeat();

      import('@capacitor/app').then(({ App }) => {
        const listener = App.addListener('appStateChange', ({ isActive }) => {
          isAppActive = isActive;
          if (!isActive) {
            lastBackgroundedAt = Date.now();
            stopHeartbeat();
          } else {
            // Always reconnect on native resume — WebView WebSocket is unreliable
            reconnectFirestore('app resumed from background');
            startHeartbeat();
          }
        });
        listener.then(handle => {
          nativeCleanup = () => handle.remove();
        });
      }).catch(err => {
        console.warn('[AppContext] App plugin not available for state change:', err);
      });
    } else {
      // Web-only: use visibilitychange with threshold (safe since no native payment popups)
      const handleVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
          lastBackgroundedAt = Date.now();
        } else if (document.visibilityState === 'visible') {
          reconnectFirestore('tab became visible');
        }
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
      nativeCleanup = () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      nativeCleanup?.();
      stopHeartbeat();
    };
  }, []);

  // Shop data listener — self-healing: retries on error instead of wiping data.
  // Firebase auto-closes onSnapshot listeners on error, so we must re-subscribe.
  useEffect(() => {
    setIsLoadingShops(true);
    let hasReceivedServerData = false;
    let unsubscribeShops: (() => void) | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    let isCleaned = false;

    const subscribe = () => {
      if (isCleaned) return;
      const shopsCollectionRef = collection(db, "shops");
      unsubscribeShops = onSnapshot(
        shopsCollectionRef,
        { includeMetadataChanges: true },
        (querySnapshot) => {
          const isFromCache = querySnapshot.metadata.fromCache;
          const fetchedShops: ShopProfile[] = [];
          querySnapshot.forEach((docSnap) => {
            fetchedShops.push({ id: docSnap.id, ...docSnap.data() } as ShopProfile);
          });

          // Always update shop data (even cached data is useful to display)
          setShops(fetchedShops);
          // Reset retry count on success — connection is healthy
          retryCount = 0;

          if (!isFromCache) {
            hasReceivedServerData = true;
            setIsLoadingShops(false);
          } else if (fetchedShops.length > 0) {
            setIsLoadingShops(false);
          } else if (!hasReceivedServerData) {
            setTimeout(() => {
              setIsLoadingShops(false);
            }, 5000);
          }
        },
        (_error) => {
          console.error('[AppContext] Shops listener error:', _error);
          // DON'T wipe shops — keep existing data so dashboards don't break.
          // The listener is now dead (Firebase auto-closed it). Re-subscribe after delay.
          setIsLoadingShops(false);

          if (retryCount < MAX_RETRIES && !isCleaned) {
            retryCount++;
            const delay = Math.min(retryCount * 3000, 10000); // 3s, 6s, 9s
            console.log(`[AppContext] Shops listener will retry in ${delay}ms (attempt ${retryCount}/${MAX_RETRIES})`);
            retryTimeout = setTimeout(() => {
              if (isCleaned) return;
              // Kick Firestore connection before re-subscribing
              enableNetwork(db).catch(() => {});
              subscribe();
            }, delay);
          } else {
            addNotificationRef.current({
              message: "Unable to load shop data. Please check your connection and refresh.",
              type: 'error',
            });
          }
        }
      );
    };

    subscribe();

    return () => {
      isCleaned = true;
      unsubscribeShops?.();
      if (retryTimeout) clearTimeout(retryTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // Orders listener - dynamically queries based on currentUser
  // Uses addNotificationRef to avoid re-subscribing when addNotification identity changes
  useEffect(() => {
    if (!currentUser) {
      setOrders([]);
      setAllOrders([]);
      return;
    }

    // Admin: listen to ALL orders
    if (currentUser.type === UserType.ADMIN) {
      const allOrdersQuery = query(collection(db, "orders"), orderBy("uploadedAt", "desc"));
      const unsubscribeAllOrders = onSnapshot(allOrdersQuery, (querySnapshot) => {
        const fetchedOrders: DocumentOrder[] = [];
        querySnapshot.forEach((doc) => {
          fetchedOrders.push({ id: doc.id, ...doc.data() } as DocumentOrder);
        });
        setAllOrders(fetchedOrders);
        setOrders(fetchedOrders); // Also set orders for compatibility
      }, (_error) => {
        // Don't wipe orders or show error — this fires during sign-out when
        // user's permissions are revoked. Sign-out cleanup handles state.
        console.warn("[AppContext] All-orders listener error (may be expected during sign-out):", _error.message || _error);
      });
      return () => unsubscribeAllOrders();
    }

    let ordersQuery;
    if (currentUser.type === UserType.STUDENT) {
      ordersQuery = query(collection(db, "orders"), where("userId", "==", currentUser.id), orderBy("uploadedAt", "desc"));
    } else if (currentUser.type === UserType.SHOP_OWNER && currentUser.shopId) {
      ordersQuery = query(collection(db, "orders"), where("shopId", "==", currentUser.shopId), orderBy("uploadedAt", "desc"));
    } else {
      setOrders([]);
      return;
    }

    const unsubscribeOrders = onSnapshot(ordersQuery, (querySnapshot) => {
      const fetchedOrders: DocumentOrder[] = [];
      querySnapshot.forEach((doc) => {
        fetchedOrders.push({ id: doc.id, ...doc.data() } as DocumentOrder);
      });
      setOrders(fetchedOrders);
    }, (_error) => {
      // Don't wipe orders or show error — this fires during sign-out when
      // user's permissions are revoked. Sign-out cleanup handles state.
      console.warn("[AppContext] Orders listener error (may be expected during sign-out):", _error.message || _error);
    });

    return () => {
      unsubscribeOrders();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);


  // Payouts listener - for admin (all payouts) and shop owners (their payouts)
  useEffect(() => {
    if (!currentUser) {
      setPayouts([]);
      return;
    }

    let payoutsQuery;
    if (currentUser.type === UserType.ADMIN) {
      payoutsQuery = query(collection(db, "payouts"), orderBy("createdAt", "desc"));
    } else if (currentUser.type === UserType.SHOP_OWNER && currentUser.shopId) {
      payoutsQuery = query(collection(db, "payouts"), where("shopId", "==", currentUser.shopId), orderBy("createdAt", "desc"));
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
      // Don't wipe payouts on errors — this fires when user's account is deleted
      // mid-session (permission denied). The sign-out flow will clear state.
      console.warn("[AppContext] Payouts listener error (may be expected during sign-out):", error.message || error);
    });

    return () => unsubscribePayouts();
  }, [currentUser]);


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
      limit(50)
    );

    const unsubscribeNotifs = onSnapshot(notifQuery, (querySnapshot) => {
      const fetched: NotificationMessage[] = [];
      querySnapshot.forEach((docSnap) => {
        fetched.push({ id: docSnap.id, ...docSnap.data() } as NotificationMessage);
      });
      setFirestoreNotifications(fetched);
    }, (error) => {
      console.error("[AppContext] Error listening to notifications:", error);
    });

    return () => unsubscribeNotifs();
  }, [currentUser]);

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
        console.log('[AppContext] User document deleted (admin action). Signing out.');
        addNotificationRef.current({
          message: 'Your account has been removed by the administrator.',
          type: 'warning',
        });
        setCurrentUserInternal(null);
        setPendingFirebaseProfileCreationUser(null);
        signOut(auth).catch((err) => {
          console.warn('[AppContext] signOut after admin deletion failed:', err);
        });
      } else {
        // Document was updated — sync the latest data (e.g., role changes, pass status)
        const updatedData = docSnap.data() as User;
        setCurrentUserInternal(updatedData);
      }
    }, (error) => {
      console.warn('[AppContext] User document listener error:', error);
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
      where('hasStudentPass', '==', true)
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
      console.error('[AppContext] Error listening to student pass holders:', error);
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
        console.log('[AppContext] Google redirect sign-in completed successfully');
        // onAuthStateChanged will handle the rest
      }
    }).catch((error) => {
      console.warn('[AppContext] getRedirectResult error:', error);
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
                console.warn(`[AppContext] Profile fetch attempt ${attempt + 1} failed, retrying...`, fetchErr);
                await enableNetwork(db).catch(() => { });
                await new Promise(r => setTimeout(r, 1500));
              } else {
                throw fetchErr;
              }
            }
          }
          throw new Error('Exhausted retries');
        };

        try {
          // Check if this user's email is in the admin list
          const isAdmin = authUser.email && ADMIN_EMAILS.includes(authUser.email.toLowerCase());

          if (isAdmin) {
            const userDocSnap = await fetchUserDoc(authUser.uid);

            if (userDocSnap.exists()) {
              const existingData = userDocSnap.data() as User;
              if (existingData.type !== UserType.ADMIN) {
                const adminProfile: User = {
                  id: authUser.uid,
                  name: authUser.displayName || existingData.name || 'Admin',
                  type: UserType.ADMIN,
                  email: authUser.email || existingData.email,
                };
                await setDoc(doc(db, "users", authUser.uid), adminProfile);
                setCurrentUserInternal(adminProfile);
              } else {
                setCurrentUserInternal(existingData);
              }
            } else {
              const adminProfile: User = {
                id: authUser.uid,
                name: authUser.displayName || 'Admin',
                type: UserType.ADMIN,
                email: authUser.email || undefined,
              };
              await setDoc(doc(db, "users", authUser.uid), adminProfile);
              setCurrentUserInternal(adminProfile);
            }
            setPendingFirebaseProfileCreationUser(null);
          } else {
            // Non-admin user
            const userDocSnap = await fetchUserDoc(authUser.uid);

            if (userDocSnap.exists()) {
              const userData = userDocSnap.data() as User;
              setCurrentUserInternal(userData);
              setPendingFirebaseProfileCreationUser(null);
            } else {
              // Profile doesn't exist in Firestore.
              // If the user was previously logged in (currentUserRef has data),
              // this means admin deleted their account → sign them out.
              if (currentUserRef.current) {
                console.log('[AppContext] Profile was deleted (admin action). Signing out user.');
                addNotificationRef.current({ message: 'Your account has been removed by the administrator.', type: 'warning' });
                setCurrentUserInternal(null);
                setPendingFirebaseProfileCreationUser(null);
                await signOut(auth);
              } else {
                // Genuinely new user — show profile creation form
                setCurrentUserInternal(null);
                setPendingFirebaseProfileCreationUser(authUser);
              }
            }
          }
        } catch (error) {
          console.error('[AppContext] Failed to load profile after retries:', error);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


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
        console.log('[AppContext] Attempting native Google Sign-In...');
        const success = await attemptNativeGoogleSignIn();
        if (!success) {
          throw new Error('Native Google Sign-In returned no result. Please ensure Google Play Services is up to date.');
        }
        console.log('[AppContext] Native Google Sign-In + Firebase credential completed');
      } else {
        // Web browser: use signInWithPopup
        console.log('[AppContext] Using signInWithPopup for web...');
        try {
          await signInWithPopup(auth, provider);
          console.log('[AppContext] signInWithPopup resolved normally');
        } catch (popupErr: unknown) {
          // COOP (Cross-Origin-Opener-Policy) can cause signInWithPopup to throw
          // even when the auth actually succeeded via onAuthStateChanged.
          // Check if Firebase already has a valid user before treating it as failure.
          if (auth.currentUser) {
            console.log('[AppContext] signInWithPopup threw but auth.currentUser exists — sign-in succeeded despite COOP');
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
        console.log('[AppContext] Auth succeeded for:', auth.currentUser.email, '— onAuthStateChanged will handle profile loading');
        // Gently nudge Firestore to reconnect its WebSocket (the popup may have
        // caused it to go stale). enableNetwork alone is safe — no disableNetwork.
        enableNetwork(db).catch(() => { });
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('[AppContext] Google Sign-In error:', errorMessage);

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
      console.warn('[AppContext] Native sign-in returned non-online response:', loginResponse);
      return false;
    }

    const idToken = loginResponse.idToken;
    if (!idToken) {
      console.warn('[AppContext] Native sign-in returned no idToken');
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
        console.warn('[AppContext] Failed to sign out after profile creation error:', getErrorMessage(signOutErr));
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
      id: newShopId, ownerUserId, name: shopName, address: shopAddress, customPricing: initialPricing, isOpen: true, isApproved: false, payoutMethods: []
    };
    try {
      await setDoc(shopDocRef, newShopData);
      return newShopData;
    } catch (err: unknown) {
      addNotification({ message: `Failed to register shop: ${getErrorMessage(err)}`, type: 'error' });
      return null;
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

    if (shops.some(s => s.name.trim().toLowerCase() === trimmedShopName.toLowerCase())) {
      setIsLoadingAuth(false);
      const message = `A shop with the name "${trimmedShopName}" already exists. Please choose a different name.`;
      addNotification({ message, type: 'error' });
      return { success: false, message };
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
        console.warn('[AppContext] Failed to sign out after shop registration error:', getErrorMessage(signOutErr));
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

  const updateShopSettings = useCallback(async (shopId: string, newSettings: { pricing: ShopPricing; isOpen: boolean; payoutMethods?: PayoutMethod[] }) => {
    try {
      const shopRef = doc(db, "shops", shopId);
      const updateData: Partial<ShopProfile> = {
        customPricing: newSettings.pricing,
        isOpen: newSettings.isOpen,
        payoutMethods: cleanPayoutMethods(newSettings.payoutMethods),
      };
      await updateDoc(shopRef, updateData);
      const shopFromState = shops.find(s => s.id === shopId);
      addNotification({
        message: `Settings updated for shop ${shopFromState?.name || shopId}.`,
        type: 'success',
        targetShopId: shopId,
        ...(shopFromState?.ownerUserId && { targetUserId: shopFromState.ownerUserId })
      });
    } catch (err: unknown) {
      addNotification({ message: `Failed to update shop settings: ${getErrorMessage(err)}`, type: 'error', targetShopId: shopId });
    }
  }, [addNotification, shops]);


  const addOrder = useCallback(async (
    orderData: {
      userId: string;
      shopId: string;
      fileInputs: { file: File; fileType: string; pageCount: number; color: PrintColor; copies: number; doubleSided: boolean }[];
    }
  ): Promise<{ success: boolean, orderId?: string }> => {
    const { userId, shopId, fileInputs } = orderData;

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
    const hasStudentPass = currentUserRef.current?.hasStudentPass ?? false;
    const calculatedPriceDetails = calculateMultiFileOrderPrice(
      fileInputs.map(f => ({ pageCount: f.pageCount, color: f.color, copies: f.copies, doubleSided: f.doubleSided })),
      targetShop.customPricing,
      hasStudentPass
    );

    const orderDocRef = doc(collection(db, "orders"));
    const orderId = orderDocRef.id;
    const uploadedAtTimestamp = new Date().toISOString();

    // Upload all files
    const uploadedFiles: OrderFile[] = [];
    addNotification({ message: `Uploading ${fileInputs.length} file(s)...`, type: 'info', targetUserId: userId });

    for (let i = 0; i < fileInputs.length; i++) {
      const fi = fileInputs[i];
      const filePath = `orders/${userId}/${orderId}/${fi.file.name}`;
      const fileRef = storageRef(storage, filePath);

      try {
        const uploadTask = uploadBytesResumable(fileRef, fi.file, {
          contentType: fi.file.type || 'application/octet-stream',
          customMetadata: { originalFileName: fi.file.name },
        });
        await new Promise<void>((resolve, reject) => {
          uploadTask.on('state_changed', null, reject, () => resolve());
        });

        uploadedFiles.push({
          fileName: fi.file.name,
          fileType: fi.fileType,
          fileStoragePath: filePath,
          fileSizeBytes: fi.file.size,
          isFileDeleted: false,
          pageCount: fi.pageCount,
          color: fi.color,
          copies: fi.copies,
          doubleSided: fi.doubleSided,
        });
      } catch (uploadError: unknown) {
        addNotification({ message: `Failed to upload ${fi.file.name}: ${getErrorMessage(uploadError)}`, type: 'error', targetUserId: userId });
        return { success: false };
      }
    }

    if (uploadedFiles.length === 0) {
      addNotification({ message: "No files were uploaded successfully.", type: 'error', targetUserId: userId });
      return { success: false };
    }

    // Aggregate values for legacy printOptions
    const totalPages = uploadedFiles.reduce((sum, f) => sum + f.pageCount, 0);
    // Use max copies per file (not sum) — the sum is misleading in UI display
    // e.g., 3 files × 2 copies each → show "2" not "6"
    const maxCopies = Math.max(...uploadedFiles.map(f => f.copies), 1);
    const primaryColor = uploadedFiles[0].color;
    const anyDoubleSided = uploadedFiles.some(f => f.doubleSided);

    const newOrder: DocumentOrder = {
      id: orderId,
      userId,
      shopId,
      // Legacy fields from first file
      fileName: uploadedFiles[0].fileName,
      fileType: uploadedFiles[0].fileType,
      fileStoragePath: uploadedFiles[0].fileStoragePath,
      fileSizeBytes: uploadedFiles[0].fileSizeBytes,
      isFileDeleted: false,
      // New multi-file array
      files: uploadedFiles,
      uploadedAt: uploadedAtTimestamp,
      status: OrderStatus.PENDING_PAYMENT,
      priceDetails: calculatedPriceDetails,
      printOptions: {
        copies: maxCopies,
        color: primaryColor,
        pages: totalPages,
        doubleSided: anyDoubleSided,
      },
      isPremiumOrder: hasStudentPass,
    };

    try {
      await setDoc(orderDocRef, newOrder);
      const fileLabel = uploadedFiles.length === 1 ? uploadedFiles[0].fileName : `${uploadedFiles.length} files`;
      addNotification({ message: `Order #${orderId.slice(-6)} for ${fileLabel} (₹${calculatedPriceDetails.totalPrice}) placed at ${targetShop.name}. Proceed to payment.`, orderId, type: 'info', targetUserId: userId });
      return { success: true, orderId };
    } catch (firestoreError: unknown) {
      addNotification({ message: `Failed to save order details: ${getErrorMessage(firestoreError)}. Please try again.`, type: 'error', targetUserId: userId });
      return { success: false };
    }

  }, [addNotification, getShopById]);

  const updateOrderStatus = useCallback(async (orderId: string, status: OrderStatus, details?: { shopNotes?: string; paymentAttemptedAt?: string; actingUserType?: UserType }): Promise<DocumentOrder | undefined> => {
    const orderDocRef = doc(db, "orders", orderId);

    try {
      // Use Firestore transaction for atomic read-then-write
      const updatedOrderInstance = await runTransaction(db, async (transaction) => {
        const orderSnap = await transaction.get(orderDocRef);

        if (!orderSnap.exists()) {
          throw new Error(`Order #${orderId.slice(-6)} not found.`);
        }

        const currentOrderData = orderSnap.data() as DocumentOrder;
        const currentStatus = currentOrderData.status;

        // Validate status transition
        const allowedTransitions = VALID_STATUS_TRANSITIONS[currentStatus];
        if (!allowedTransitions || !allowedTransitions.includes(status)) {
          throw new Error(
            `Invalid status transition: cannot move from "${currentStatus.replace(/_/g, ' ')}" to "${status.replace(/_/g, ' ')}".`
          );
        }

        // Build update payload
        const updatePayload: Partial<DocumentOrder> = { status };
        if (details?.shopNotes !== undefined) updatePayload.shopNotes = details.shopNotes;
        if (details?.paymentAttemptedAt) updatePayload.paymentAttemptedAt = details.paymentAttemptedAt;
        if (status === OrderStatus.READY_FOR_PICKUP && !currentOrderData.pickupCode) {
          updatePayload.pickupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        }

        // Atomic write inside transaction
        transaction.update(orderDocRef, updatePayload);

        return { ...currentOrderData, ...updatePayload };
      });

      // NOTE: File cleanup is handled exclusively by the server-side onOrderStatusChange
      // Cloud Function trigger, which handles both legacy single-file and multi-file orders.
      // Removed client-side cleanup to avoid race conditions with the server trigger.

      // Send notifications
      if (updatedOrderInstance) {
        const targetShop = getShopById(updatedOrderInstance.shopId);
        let studentUserName = 'Student';
        try {
          const userDocRefFs = doc(db, "users", updatedOrderInstance.userId);
          const userDocSnap = await getDoc(userDocRefFs);
          if (userDocSnap.exists()) { studentUserName = (userDocSnap.data() as User).name || studentUserName; }
        } catch (e) { console.warn("[AppContext/updateOrderStatus] Could not fetch student user's name for notification", e) }

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

  // --- Admin Payout Functions ---
  const createPayout = useCallback(async (shopId: string, shopName: string, amount: number, adminNote?: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      return { success: false, message: "Only admins can create payouts." };
    }
    if (amount <= 0) {
      return { success: false, message: "Amount must be greater than 0." };
    }
    try {
      const payoutDocRef = doc(collection(db, "payouts"));
      const newPayout: ShopPayout = {
        id: payoutDocRef.id,
        shopId,
        shopName,
        amount,
        adminNote: adminNote || '',
        status: PayoutStatus.PAID,
        createdAt: new Date().toISOString(),
        paidAt: new Date().toISOString(),
      };
      await setDoc(payoutDocRef, newPayout);
      addNotification({ message: `Payout of ₹${amount.toFixed(2)} created for ${shopName}.`, type: 'success' });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to create payout: ${message}`, type: 'error' });
      return { success: false, message };
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
      const payoutDocRef = doc(collection(db, "payouts"));
      const newPayout: ShopPayout = {
        id: payoutDocRef.id,
        shopId,
        shopName,
        amount,
        shopOwnerNote: shopOwnerNote || '',
        status: PayoutStatus.PENDING,
        createdAt: new Date().toISOString(),
      };
      await setDoc(payoutDocRef, newPayout);
      addNotification({ message: `Payout request of ₹${amount.toFixed(2)} submitted. Admin will review and process it.`, type: 'success', targetShopId: shopId });
      // Notify admin about the request
      addNotification({ message: `${shopName} has requested a payout of ₹${amount.toFixed(2)}.`, type: 'info', targetUserId: 'ADMIN' });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to request payout: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification]);

  const markPayoutPaid = useCallback(async (payoutId: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      return { success: false, message: "Only admins can mark payouts as paid." };
    }
    try {
      const payoutRef = doc(db, "payouts", payoutId);
      await updateDoc(payoutRef, {
        status: PayoutStatus.PAID,
        paidAt: new Date().toISOString(),
      });
      addNotification({ message: `Payout marked as paid.`, type: 'success' });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: getErrorMessage(err) };
    }
  }, [currentUser, addNotification]);

  const confirmPayout = useCallback(async (payoutId: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.SHOP_OWNER) {
      return { success: false, message: "Only shop owners can confirm payouts." };
    }
    try {
      const payoutRef = doc(db, "payouts", payoutId);
      await updateDoc(payoutRef, {
        status: PayoutStatus.CONFIRMED,
        confirmedAt: new Date().toISOString(),
      });
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
      const payoutRef = doc(db, "payouts", payoutId);
      await updateDoc(payoutRef, {
        status: PayoutStatus.DISPUTED,
        shopOwnerNote,
      });
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
        console.error("[AppContext] Failed to mark notification as read:", err);
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
      const shopRef = doc(db, "shops", shopId);
      await updateDoc(shopRef, { isApproved: true });
      addNotification({ message: `Shop approved successfully.`, type: 'success' });
      // Notify shop owner
      const shop = shops.find(s => s.id === shopId);
      if (shop) {
        addNotification({
          message: `Your shop "${shop.name}" has been approved by the admin! You can now accept orders.`,
          type: 'success',
          targetUserId: shop.ownerUserId,
          targetShopId: shopId,
        });
      }
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to approve shop: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification, shops]);

  const rejectShop = useCallback(async (shopId: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      return { success: false, message: "Only admins can reject shops." };
    }
    try {
      const shop = shops.find(s => s.id === shopId);
      // Delete the shop document
      await deleteDoc(doc(db, "shops", shopId));
      // Also delete the owner's user profile so they can re-register
      if (shop) {
        await deleteDoc(doc(db, "users", shop.ownerUserId));
        addNotification({
          message: `Shop "${shop.name}" registration was rejected.`,
          type: 'warning',
          targetUserId: shop.ownerUserId,
        });
      }
      addNotification({ message: `Shop rejected and removed.`, type: 'info' });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to reject shop: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification, shops]);

  const deleteShopAndOwner = useCallback(async (shopId: string, ownerUserId: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      return { success: false, message: "Only admins can delete shops." };
    }
    try {
      // Delete the shop
      await deleteDoc(doc(db, "shops", shopId));
      // Delete the owner's user profile
      await deleteDoc(doc(db, "users", ownerUserId));
      addNotification({ message: `Shop and owner account deleted.`, type: 'success' });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to delete shop: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification]);

  // Archive / Unarchive shop (admin)
  const archiveShop = useCallback(async (shopId: string): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.ADMIN) {
      return { success: false, message: "Only admins can archive shops." };
    }
    try {
      const shopRef = doc(db, "shops", shopId);
      await updateDoc(shopRef, { isArchived: true, isOpen: false });
      const shop = shops.find(s => s.id === shopId);
      addNotification({ message: `Shop "${shop?.name || shopId}" has been archived.`, type: 'info' });
      if (shop) {
        addNotification({
          message: `Your shop "${shop.name}" has been archived by the admin. It is no longer visible to students.`,
          type: 'warning',
          targetUserId: shop.ownerUserId,
          targetShopId: shopId,
        });
      }
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
      if (shop) {
        addNotification({
          message: `Your shop "${shop.name}" has been restored by the admin. You can now accept orders again.`,
          type: 'success',
          targetUserId: shop.ownerUserId,
          targetShopId: shopId,
        });
      }
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to unarchive shop: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification, shops]);

  // Shop owner self-delete account
  const deleteOwnShopAccount = useCallback(async (): Promise<{ success: boolean; message?: string }> => {
    if (!currentUser || currentUser.type !== UserType.SHOP_OWNER || !currentUser.shopId) {
      return { success: false, message: "Only shop owners can delete their own account." };
    }
    try {
      // Delete the shop document
      await deleteDoc(doc(db, "shops", currentUser.shopId));
      // Delete the user profile document
      await deleteDoc(doc(db, "users", currentUser.id));
      // Sign out
      await signOut(auth);
      addNotification({ message: "Your shop account has been deleted.", type: 'info' });
      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      addNotification({ message: `Failed to delete account: ${message}`, type: 'error' });
      return { success: false, message };
    }
  }, [currentUser, addNotification]);

  // Approved shops — only approved and non-archived shops visible to students
  const approvedShops = useMemo(() => shops.filter(s => s.isApproved && !s.isArchived), [shops]);

  const contextValue = useMemo(() => ({
    currentUser, isLoadingAuth, pendingFirebaseProfileCreationUser, setPendingFirebaseProfileCreationUser,
    signInWithGoogle, signUpWithEmailPassword, signInWithEmailAndPassword: signInWithEmailAndPasswordInternal,
    completeStudentProfileCreation, completeShopOwnerProfileCreation, logoutUser,
    shops, isLoadingShops, getShopById, registerShop, updateShopSettings,
    orders, allOrders, getOrdersForCurrentUser,
    notifications,
    addOrder, updateOrderStatus,
    addNotification, markNotificationAsRead, getNotificationsForCurrentUser,
    currentView, navigateTo, goBack, upgradeToStudentPass, cancelStudentPass,
    payouts, createPayout, requestPayout, markPayoutPaid, confirmPayout, disputePayout,
    approveShop, rejectShop, deleteShopAndOwner, archiveShop, unarchiveShop, approvedShops,
    deleteOwnShopAccount,
    studentPassHolders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [
    currentUser, isLoadingAuth, pendingFirebaseProfileCreationUser,
    shops, isLoadingShops, orders, allOrders, notifications, currentView, payouts, approvedShops, studentPassHolders
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
