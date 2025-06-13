

import React, { createContext, useState, useContext, useCallback, ReactNode, useEffect } from 'react';
import { DocumentOrder, NotificationMessage, OrderStatus, User, UserType, ShopProfile, ShopPricing, PrintOptions, PrintColor, PayoutMethod } from '../types';
import { DEFAULT_SHOP_PRICING } from '../constants';
import {
  auth,
  db, 
  storage, 
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword as firebaseSignInWithEmailAndPassword, 
  doc,
  setDoc,
  getDoc,
  updateDoc, 
  collection, 
  query, // Added for querying
  where,   // Added for querying
  orderBy, // Added for querying
  FirebaseUser,
  storageRef,         
  uploadBytesResumable, 
  // getDownloadURL, // Removed as unused in this file; it's used elsewhere via firebase.ts
  updateProfile,
  onSnapshot 
} from '../firebase';

// --- Helper: New Base Fee Logic ---
export const calculateBaseFee = (pageCost: number): number => {
  if (pageCost <= 0) return 0;
  if (pageCost <= 5) return 2;
  if (pageCost <= 30) return 3;
  if (pageCost <= 70) return 4;
  return 5;
};

export const calculateOrderPrice = (
  printOptions: PrintOptions,
  shopPricing: ShopPricing
): DocumentOrder['priceDetails'] => {
  const { pages, copies, color, doubleSided } = printOptions;
  if (pages <= 0 || copies <= 0) return { pageCost: 0, baseFee: 0, totalPrice: 0 };

  let perPageRate = color === PrintColor.COLOR ? shopPricing.colorPerPage : shopPricing.bwPerPage;
  if (doubleSided) perPageRate *= 1.8;

  const calculatedPageCost = pages * perPageRate * copies;
  const calculatedBaseFee = calculateBaseFee(calculatedPageCost);
  const calculatedTotalPrice = calculatedPageCost + calculatedBaseFee;

  return {
    pageCost: parseFloat(calculatedPageCost.toFixed(2)),
    baseFee: parseFloat(calculatedBaseFee.toFixed(2)),
    totalPrice: parseFloat(calculatedTotalPrice.toFixed(2)),
  };
};

interface AppContextType {
  currentUser: User | null;
  isLoadingAuth: boolean;
  pendingFirebaseProfileCreationUser: FirebaseUser | null;
  setPendingFirebaseProfileCreationUser: React.Dispatch<React.SetStateAction<FirebaseUser | null>>;

  signInWithGoogle: () => Promise<void>;
  signUpWithEmailPassword: (email: string, password: string, displayName: string) => Promise<{ success: boolean; message?: string }>;
  signInWithEmailAndPassword: (email: string, password: string) => Promise<{ success: boolean; message?: string; errorCode?: string }>; 
  completeStudentProfileCreation: (authUser: FirebaseUser, displayName?: string) => Promise<{success: boolean; message?: string}>;
  completeShopOwnerProfileCreation: (authUser: FirebaseUser, shopDetails: { shopName: string; shopAddress: string }, displayName?:string) => Promise<{success: boolean; message?: string; shopId?: string}>;
  logoutUser: () => Promise<void>;

  shops: ShopProfile[];
  isLoadingShops: boolean; // Added for shop loading state
  getShopById: (shopId: string) => ShopProfile | undefined;
  registerShop: (shopName: string, shopAddress: string, ownerUserId: string, initialPricing: ShopPricing) => Promise<ShopProfile | null>; 
  updateShopSettings: (shopId: string, newSettings: { pricing: ShopPricing; isOpen: boolean; payoutMethods?: PayoutMethod[] }) => Promise<void>; 

  orders: DocumentOrder[];
  getOrdersForCurrentUser: () => DocumentOrder[]; // This will now use the Firestore-populated 'orders' state

  notifications: NotificationMessage[];
  addOrder: (orderData: Omit<DocumentOrder, 'id' | 'uploadedAt' | 'priceDetails' | 'status' | 'fileStoragePath' | 'fileSizeBytes' | 'isFileDeleted'> & { priceDetailsInput: Pick<DocumentOrder, 'shopId' | 'printOptions'>; fileObject: File }) => Promise<{success: boolean, orderId?: string}>; 
  updateOrderStatus: (orderId: string, status: OrderStatus, details?: { shopNotes?: string; paymentAttemptedAt?: string; actingUserType?: UserType }) => Promise<DocumentOrder | undefined>; 

  addNotification: (notification: Omit<NotificationMessage, 'id' | 'timestamp' | 'read'>) => void;
  markNotificationAsRead: (notificationId: string) => void;
  getNotificationsForCurrentUser: () => NotificationMessage[];
}

const AppContext = createContext<AppContextType | undefined>(undefined);

// Helper function to clean payout methods array
const cleanPayoutMethods = (methods?: PayoutMethod[]): PayoutMethod[] => {
  if (!methods) return [];
  // This filter ensures that the array itself does not contain null/undefined PayoutMethod objects.
  // The properties *within* each PayoutMethod object are assumed to be cleaned before this point
  // (e.g., in ShopSettingsModal before calling onSaveSettings).
  return methods.filter(method => method !== null && method !== undefined); 
};

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUserInternal] = useState<User | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState<boolean>(true);
  const [pendingFirebaseProfileCreationUser, setPendingFirebaseProfileCreationUser] = useState<FirebaseUser | null>(null);

  const [shops, setShops] = useState<ShopProfile[]>([]); 
  const [isLoadingShops, setIsLoadingShops] = useState<boolean>(true); // Initial state for shop loading
  const [orders, setOrders] = useState<DocumentOrder[]>([]); 
  const [notifications, setNotifications] = useState<NotificationMessage[]>([]);

  const addNotification = useCallback((notificationData: Omit<NotificationMessage, 'id' | 'timestamp' | 'read'>) => {
    const newNotification: NotificationMessage = {
      ...notificationData,
      id: Date.now().toString() + Math.random().toString(16).slice(2),
      timestamp: new Date().toISOString(),
      read: false,
    };
    setNotifications(prev => [newNotification, ...prev].slice(0, 20));
  }, []);

  // Shop data listener
  useEffect(() => {
    setIsLoadingShops(true); // Set loading true when effect runs or refreshes
    console.log("[AppContext/ShopListenerEffect] Setting up Firestore listener for 'shops' collection.");
    const shopsCollectionRef = collection(db, "shops");
    const unsubscribeShops = onSnapshot(shopsCollectionRef, (querySnapshot) => {
        const fetchedShops: ShopProfile[] = [];
        querySnapshot.forEach((doc) => {
            fetchedShops.push({ id: doc.id, ...doc.data() } as ShopProfile);
        });
        console.log(`[AppContext/ShopListenerEffect] Shop data updated from Firestore listener. Found ${fetchedShops.length} shops.`);
        setShops(fetchedShops); 
        setIsLoadingShops(false); // Set loading false after data is fetched
    }, (error) => {
        console.error("[AppContext/ShopListenerEffect] Error listening to shops collection:", error);
        addNotification({ message: "Error updating shop list from Firestore. Please try refreshing.", type: 'error' });
        setShops([]); 
        setIsLoadingShops(false); // Set loading false even on error
    });
    return () => {
        console.log("[AppContext/ShopListenerEffect] Unsubscribing from Firestore 'shops' listener.");
        unsubscribeShops();
    };
  }, [addNotification]);


  // Orders listener - dynamically queries based on currentUser
  useEffect(() => {
    if (!currentUser) {
      setOrders([]); // Clear orders if no user is logged in
      return;
    }

    let ordersQuery;
    if (currentUser.type === UserType.STUDENT) {
      ordersQuery = query(collection(db, "orders"), where("userId", "==", currentUser.id), orderBy("uploadedAt", "desc"));
      console.log(`[AppContext/OrdersListenerEffect] Setting up Firestore listener for student orders. UserID: ${currentUser.id}`);
    } else if (currentUser.type === UserType.SHOP_OWNER && currentUser.shopId) {
      ordersQuery = query(collection(db, "orders"), where("shopId", "==", currentUser.shopId), orderBy("uploadedAt", "desc"));
      console.log(`[AppContext/OrdersListenerEffect] Setting up Firestore listener for shop orders. ShopID: ${currentUser.shopId}`);
    } else {
      setOrders([]); // Clear orders if user type or shopId is missing
      return;
    }

    const unsubscribeOrders = onSnapshot(ordersQuery, (querySnapshot) => {
      const fetchedOrders: DocumentOrder[] = [];
      querySnapshot.forEach((doc) => {
        fetchedOrders.push({ id: doc.id, ...doc.data() } as DocumentOrder);
      });
      console.log(`[AppContext/OrdersListenerEffect] Orders data updated. Fetched ${fetchedOrders.length} orders.`);
      setOrders(fetchedOrders);
    }, (error) => {
      console.error("[AppContext/OrdersListenerEffect] Error listening to orders collection:", error);
      addNotification({ message: "Error fetching your orders. Please try again.", type: 'error' });
      setOrders([]); // Set to empty on error
    });

    return () => {
      console.log("[AppContext/OrdersListenerEffect] Unsubscribing from Firestore 'orders' listener.");
      unsubscribeOrders();
    };
  }, [currentUser, addNotification]); // Re-run when currentUser changes


  useEffect(() => {
    setIsLoadingAuth(true);
    const unsubscribe = onAuthStateChanged(auth, async (authUser) => {
      if (authUser) {
        try {
          const userDocRef = doc(db, "users", authUser.uid);
          const userDocSnap = await getDoc(userDocRef);

          if (userDocSnap.exists()) {
            const userData = userDocSnap.data() as User;
            setCurrentUserInternal(userData);
            setPendingFirebaseProfileCreationUser(null); 
          } else {
            setCurrentUserInternal(null);
            setPendingFirebaseProfileCreationUser(authUser);
            console.log(`[AppContext/onAuthStateChanged] Firebase user ${authUser.uid} authenticated, but no profile in Firestore. Setting as pending.`);
          }
        } catch (error) {
          console.error("[AppContext/onAuthStateChanged] Error processing auth state:", error);
          addNotification({ message: "Error loading your profile.", type: 'error' });
          setCurrentUserInternal(null);
          setPendingFirebaseProfileCreationUser(null);
        } finally {
          setIsLoadingAuth(false);
        }
      } else { 
        setCurrentUserInternal(null);
        setPendingFirebaseProfileCreationUser(null);
        setIsLoadingAuth(false);
        console.log("[AppContext/onAuthStateChanged] No Firebase user authenticated.");
      }
    });
    return () => unsubscribe();
  }, [addNotification]);


  const handleAuthError = (error: any, context: string): { message: string; errorCode?: string } => {
    console.error(`[AppContext] ${context} Error:`, error.code, error.message);
    let message = `Authentication failed. Please try again.`;
    const errorCode = error.code;

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
        default: message = error.message || 'An unexpected error occurred during authentication.';
      }
    }
    addNotification({ message, type: 'error' });
    return { message, errorCode };
  };

  const signInWithGoogle = async (): Promise<void> => {
    setIsLoadingAuth(true);
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      handleAuthError(error, "Google Sign-In");
      setCurrentUserInternal(null); 
      setPendingFirebaseProfileCreationUser(null);
      setIsLoadingAuth(false); 
    }
  };

  const signUpWithEmailPassword = async (email: string, password: string, displayName: string): Promise<{ success: boolean; message?: string }> => {
    setIsLoadingAuth(true);
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      if (userCredential.user && displayName) {
        await updateProfile(userCredential.user, { displayName });
      }
      return { success: true };
    } catch (error: any) {
      const { message } = handleAuthError(error, "Email/Password Sign-Up");
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
    } catch (error: any) {
      const { message, errorCode } = handleAuthError(error, "Email/Password Sign-In");
      setCurrentUserInternal(null);
      setPendingFirebaseProfileCreationUser(null);
      setIsLoadingAuth(false);
      return { success: false, message, errorCode };
    }
  };

  const completeStudentProfileCreation = useCallback(async (authUser: FirebaseUser, displayName?: string): Promise<{success: boolean; message?: string}> => {
    setIsLoadingAuth(true);
    try {
      const studentName = displayName || authUser.displayName || `Student ${authUser.uid.slice(0,6)}`;
      const studentProfileData: User = { 
        id: authUser.uid, 
        name: studentName, 
        type: UserType.STUDENT,
        // email is optional, only add if it exists to avoid undefined in Firestore
        ...(authUser.email && { email: authUser.email }), 
      };
      
      await setDoc(doc(db, "users", authUser.uid), studentProfileData);
      
      // Critical: Update context state immediately after successful Firestore write
      setCurrentUserInternal(studentProfileData);
      setPendingFirebaseProfileCreationUser(null);

      addNotification({message: `Welcome, ${studentName}! Registration successful.`, type: 'success', targetUserId: studentProfileData.id});
      return {success: true};
    } catch (error: any) {
      console.error("[AppContext/completeStudentProfileCreation] Error saving profile:", error);
      const message = (error as Error).message || 'Could not save student profile to Firestore.';
      addNotification({message: `Registration failed: ${message}`, type: 'error'});
      try {
        if (auth.currentUser) await signOut(auth); // Sign out if profile creation fails
      } catch (signOutError) {
        console.error("[AppContext/completeStudentProfileCreation] Error signing out user after profile save failure:", signOutError);
      }
      return {success: false, message};
    } finally {
      setIsLoadingAuth(false);
    }
  }, [addNotification]);
  
  const registerShop = useCallback(async (shopName: string, shopAddress: string, ownerUserId: string, initialPricing: ShopPricing): Promise<ShopProfile | null> => {
    const shopDocRef = doc(collection(db, "shops")); 
    const newShopId = shopDocRef.id;

    const newShopData: ShopProfile = {
      id: newShopId, ownerUserId, name: shopName, address: shopAddress, customPricing: initialPricing, isOpen: true, payoutMethods: []
    };
    try {
      await setDoc(shopDocRef, newShopData); 
      console.log(`[AppContext/registerShop] Shop registered successfully in Firestore. ID: ${newShopId}`);
      return newShopData; 
    } catch (error: any) {
      console.error("[AppContext/registerShop] Error saving shop to Firestore:", error);
      addNotification({ message: `Failed to register shop: ${error.message}`, type: 'error' });
      return null;
    }
  }, [addNotification]);

  const completeShopOwnerProfileCreation = useCallback(async (
    authUser: FirebaseUser,
    shopDetails: { shopName: string; shopAddress: string },
    displayName?: string
  ): Promise<{success: boolean; message?: string; shopId?: string}> => {
    setIsLoadingAuth(true);

    const trimmedShopName = shopDetails.shopName.trim();
    if (!trimmedShopName) {
      setIsLoadingAuth(false);
      const message = "Shop name cannot be empty.";
      addNotification({message, type: 'error'});
      return {success: false, message};
    }

    // Case-insensitive check for existing shop name
    if (shops.some(s => s.name.trim().toLowerCase() === trimmedShopName.toLowerCase())) {
      setIsLoadingAuth(false);
      const message = `A shop with the name "${trimmedShopName}" already exists. Please choose a different name.`;
      addNotification({message, type: 'error'});
      return {success: false, message};
    }

    let newShop: ShopProfile | null = null;
    try {
      newShop = await registerShop(trimmedShopName, shopDetails.shopAddress, authUser.uid, DEFAULT_SHOP_PRICING);
      
      if (!newShop || typeof newShop.id !== 'string' || newShop.id.trim() === '') {
        console.error("[AppContext/completeShopOwnerProfileCreation] Failed to register shop or received invalid shop ID. newShop:", newShop);
        throw new Error("Failed to register shop profile in Firestore. Shop data or ID is null/invalid or not a string.");
      }

      const ownerName = displayName || authUser.displayName || `Shop Owner ${authUser.uid.slice(0,6)}`;
      
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
      
      addNotification({message: `Welcome, ${ownerName}! Shop '${newShop.name}' registered.`, type: 'success', targetUserId: shopOwnerProfileData.id});
      return {success: true, shopId: newShop.id};
    } catch (error: any) {
      console.error("[AppContext/completeShopOwnerProfileCreation] Error saving profile/shop:", error);
      const message = (error as Error).message || 'Could not save shop owner profile or shop details.';
      addNotification({message: `Shop registration failed: ${message}`, type: 'error'});
      try {
        if (auth.currentUser) await signOut(auth); 
      } catch (signOutError) {
        console.error("[AppContext/completeShopOwnerProfileCreation] Error signing out user after profile/shop save failure:", signOutError);
      }
      return {success: false, message};
    } finally {
      setIsLoadingAuth(false);
    }
  }, [registerShop, addNotification, shops]); // Added `shops` to dependency array

  const logoutUser = async (): Promise<void> => {
    setIsLoadingAuth(true);
    try {
      await signOut(auth);
    } catch (error: any) {
      handleAuthError(error, "Logout");
    } finally {
      setIsLoadingAuth(false); 
    }
  };

  const getShopById = useCallback((shopId: string) => shops.find(s => s.id === shopId), [shops]);
  
  const updateShopSettings = useCallback(async (shopId: string, newSettings: { pricing: ShopPricing; isOpen: boolean; payoutMethods?: PayoutMethod[] }) => {
    try {
        const shopRef = doc(db, "shops", shopId);
        // PayoutMethods are assumed to be cleaned by the caller (ShopSettingsModal)
        // cleanPayoutMethods here just ensures the array itself is valid
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
    } catch (error: any) {
        console.error(`[AppContext/updateShopSettings] Error updating shop ${shopId} in Firestore:`, error);
        addNotification({ message: `Failed to update shop settings: ${error.message}`, type: 'error', targetShopId: shopId });
    }
  }, [addNotification, shops]);


  const addOrder = useCallback(async (
    orderData: Omit<DocumentOrder, 'id' | 'uploadedAt' | 'priceDetails' | 'status' | 'fileStoragePath' | 'fileSizeBytes' | 'isFileDeleted'> & { priceDetailsInput: Pick<DocumentOrder, 'shopId' | 'printOptions'>; fileObject: File }
  ): Promise<{success: boolean, orderId?: string}> => {
    const { fileObject, priceDetailsInput, ...serializableOrderData } = orderData;

    const targetShop = getShopById(priceDetailsInput.shopId);
    if (!targetShop) {
      addNotification({message: "Error placing order: Selected shop not found.", type: 'error', targetUserId: serializableOrderData.userId});
      return {success: false};
    }
    if (!targetShop.isOpen) {
      addNotification({message: `Error placing order: Shop '${targetShop.name}' is currently closed.`, type: 'error', targetUserId: serializableOrderData.userId});
      return {success: false};
    }

    const calculatedPriceDetails = calculateOrderPrice(priceDetailsInput.printOptions, targetShop.customPricing);
    
    const orderDocRef = doc(collection(db, "orders"));
    const orderId = orderDocRef.id;
    const uploadedAtTimestamp = new Date().toISOString();
    
    let actualFileStoragePath: string | undefined = undefined;
    let fileSizeBytesValue: number | undefined = undefined;

    if (fileObject && serializableOrderData.userId) {
      const filePath = `orders/${serializableOrderData.userId}/${orderId}/${fileObject.name}`;
      const fileRef = storageRef(storage, filePath);
      fileSizeBytesValue = fileObject.size;
      
      try {
        addNotification({ message: `Uploading ${fileObject.name}...`, type: 'info', targetUserId: serializableOrderData.userId });
        const uploadTask = uploadBytesResumable(fileRef, fileObject);
        await new Promise<void>((resolve, reject) => {
          uploadTask.on('state_changed',
            (_snapshot) => { /* TODO: Progress reporting */ },
            (error) => { 
              console.error("[AppContext/addOrder] File upload error:", error);
              reject(error); 
            },
            () => { actualFileStoragePath = filePath; resolve(); }
          );
        });
      } catch (uploadError: any) {
        addNotification({ message: `Failed to upload file: ${uploadError.message}. Please try again.`, type: 'error', targetUserId: serializableOrderData.userId });
        return {success: false};
      }
    } else {
        addNotification({ message: "File or user information missing, cannot upload.", type: 'error', targetUserId: serializableOrderData.userId });
        return {success: false};
    }

    if (!actualFileStoragePath) {
        addNotification({ message: `Order for ${serializableOrderData.fileName} could not be placed due to file upload issue.`, type: 'error', targetUserId: serializableOrderData.userId });
        return {success: false};
    }

    let orderingUserName = `User ${serializableOrderData.userId.slice(0,6)}`;
    try {
        const userDocRefFs = doc(db, "users", serializableOrderData.userId); 
        const userDocSnap = await getDoc(userDocRefFs); 
        if(userDocSnap.exists()){ orderingUserName = (userDocSnap.data() as User).name || orderingUserName; }
    } catch(e) { console.warn("[AppContext/addOrder] Could not fetch ordering user's name", e)}

    const newOrder: DocumentOrder = {
      ...serializableOrderData, 
      id: orderId, 
      uploadedAt: uploadedAtTimestamp, 
      status: OrderStatus.PENDING_PAYMENT,
      priceDetails: calculatedPriceDetails, 
      shopId: priceDetailsInput.shopId, 
      fileStoragePath: actualFileStoragePath, 
      fileSizeBytes: fileSizeBytesValue, 
      isFileDeleted: false,
    };
    
    try {
        await setDoc(orderDocRef, newOrder); 
        addNotification({ message: `Order #${newOrder.id.slice(-6)} for ${newOrder.fileName} (₹${newOrder.priceDetails.totalPrice}) placed at ${targetShop.name}. Proceed to payment.`, orderId: newOrder.id, type: 'info', targetUserId: newOrder.userId });
        addNotification({ message: `New job #${newOrder.id.slice(-6)} (${newOrder.fileName}) awaits payment. Customer: ${orderingUserName}.`, orderId: newOrder.id, type: 'info', targetShopId: newOrder.shopId });
        return {success: true, orderId: newOrder.id};
    } catch (firestoreError: any) {
        console.error("[AppContext/addOrder] Error saving order to Firestore:", firestoreError);
        addNotification({ message: `Failed to save order details: ${firestoreError.message}. Please try again.`, type: 'error', targetUserId: serializableOrderData.userId });
        return {success: false};
    }

  }, [addNotification, getShopById]);

  const updateOrderStatus = useCallback(async (orderId: string, status: OrderStatus, details?: { shopNotes?: string; paymentAttemptedAt?: string; actingUserType?: UserType }): Promise<DocumentOrder | undefined> => {
    const orderDocRef = doc(db, "orders", orderId);
    let updatedOrderInstance: DocumentOrder | undefined;

    try {
      const updatePayload: Partial<DocumentOrder> = { status };
      if (details?.shopNotes !== undefined) updatePayload.shopNotes = details.shopNotes;
      if (details?.paymentAttemptedAt) updatePayload.paymentAttemptedAt = details.paymentAttemptedAt;
      if (status === OrderStatus.READY_FOR_PICKUP) {
        const currentOrderSnap = await getDoc(orderDocRef);
        if (currentOrderSnap.exists()) {
            const currentOrderData = currentOrderSnap.data() as DocumentOrder;
            if (!currentOrderData.pickupCode) {
                 updatePayload.pickupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
            }
            updatedOrderInstance = { ...currentOrderData, ...updatePayload };
        } else {
            console.error(`[AppContext/updateOrderStatus] Order ${orderId} not found in Firestore for update.`);
            return undefined;
        }
      } else {
         const currentOrderSnap = await getDoc(orderDocRef);
         if (currentOrderSnap.exists()) {
             updatedOrderInstance = { ...currentOrderSnap.data() as DocumentOrder, ...updatePayload };
         }
      }
      
      await updateDoc(orderDocRef, updatePayload);
      console.log(`[AppContext/updateOrderStatus] Order ${orderId} successfully updated to status ${status} in Firestore.`);
      
      if (updatedOrderInstance) {
        const targetShop = getShopById(updatedOrderInstance.shopId);
        let studentUserName = `User ${updatedOrderInstance.userId.slice(0,6)}`;
         try {
          const userDocRefFs = doc(db, "users", updatedOrderInstance.userId); 
          const userDocSnap = await getDoc(userDocRefFs); 
          if(userDocSnap.exists()){ studentUserName = (userDocSnap.data() as User).name || studentUserName; }
        } catch(e) { console.warn("[AppContext/updateOrderStatus] Could not fetch student user's name for notification", e)}

        let studentMessage = `Order #${orderId.slice(-6)} (${updatedOrderInstance.fileName}) at ${targetShop?.name || 'shop'} is now ${status.replace(/_/g, ' ').toLowerCase()}.`;
        let shopMessage = `Order #${orderId.slice(-6)} (${updatedOrderInstance.fileName}) by ${studentUserName} is now ${status.replace(/_/g, ' ').toLowerCase()}.`;
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
    } catch (firestoreError: any) {
      console.error(`[AppContext/updateOrderStatus] Error updating order ${orderId} in Firestore:`, firestoreError);
      addNotification({ message: `Failed to update order status: ${firestoreError.message}`, type: 'error' });
      return undefined;
    }
  }, [addNotification, getShopById]);

  const markNotificationAsRead = useCallback((notificationId: string) => {
    setNotifications(prev => prev.map(n => (n.id === notificationId ? { ...n, read: true } : n)));
  }, []);

  const getNotificationsForCurrentUser = useCallback(() => {
    if (!currentUser) return [];
    return notifications.filter(n => {
      if (n.targetUserId === currentUser.id) return true;
      if (currentUser.type === UserType.SHOP_OWNER && n.targetShopId === currentUser.shopId && !n.targetUserId) return true;
      return false;
    }).sort((a,b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [notifications, currentUser]);

  const getOrdersForCurrentUser = useCallback(() => {
    return orders;
  }, [orders]);

  return (
    <AppContext.Provider value={{
        currentUser, isLoadingAuth, pendingFirebaseProfileCreationUser, setPendingFirebaseProfileCreationUser,
        signInWithGoogle, signUpWithEmailPassword, signInWithEmailAndPassword: signInWithEmailAndPasswordInternal,
        completeStudentProfileCreation, completeShopOwnerProfileCreation, logoutUser,
        shops, isLoadingShops, getShopById, registerShop, updateShopSettings,
        orders, getOrdersForCurrentUser,
        notifications,
        addOrder, updateOrderStatus,
        addNotification, markNotificationAsRead, getNotificationsForCurrentUser,
    }}>
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
