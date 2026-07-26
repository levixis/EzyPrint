// firebase.ts

import { initializeApp, getApp, getApps, FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  connectAuthEmulator,
  updateProfile // Added import for updateProfile
} from 'firebase/auth';
import type { User as FirebaseUser } from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  writeBatch,
  collection,
  getDocs,
  connectFirestoreEmulator,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,          // Added for capping notification queries
  addDoc,         // Added for creating notification documents
  enableNetwork,  // Added for app resume reconnection
  or              // Added for complex composite queries
} from 'firebase/firestore';
import {
  getStorage,
  connectStorageEmulator,
  ref as storageRef, // Added for explicit naming
  uploadBytesResumable, // Added for uploads
  getDownloadURL,      // Added for getting download URLs
  getBlob,             // Added for CORS-safe file downloads
  deleteObject         // Added for file cleanup after order completion
} from 'firebase/storage';
import { getFunctions, httpsCallable } from 'firebase/functions';

const debugLog = (...args: unknown[]) => {
  void args;
};

// Firebase configuration — reads from environment variables (VITE_ prefix for Vite exposure)
// Empty string fallbacks ensure no accidental repository credential leakage.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  // Use the web.app domain (same as hosting) to prevent cross-origin storage
  // partitioning issues with signInWithRedirect in Android WebViews
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || ""
};

// Initialize Firebase
let app: FirebaseApp;
if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApp();
}

const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app, 'asia-south1');


// --- Environment Detection Logic ---
const viteDevMode = import.meta.env.DEV === true;
const actualHostname = typeof window !== 'undefined' && typeof window.location !== 'undefined'
  ? window.location.hostname
  : "unknown_hostname";
const isLocalHostname = actualHostname === "127.0.0.1" || actualHostname === "localhost";
const connectToEmulators = viteDevMode && isLocalHostname;


if (connectToEmulators) {
  try {
    // Simplified connectAuthEmulator call
    connectAuthEmulator(auth, "http://127.0.0.1:9099");
  } catch {
    // Ignore duplicate emulator-init failures.
  }

  try {
    connectFirestoreEmulator(db, "127.0.0.1", 8081);
  } catch {
    // Ignore duplicate emulator-init failures.
  }

  try {
    connectStorageEmulator(storage, "127.0.0.1", 9199);
  } catch {
    // Ignore duplicate emulator-init failures.
  }
} else {
  debugLog(`[Firebase] Production mode (host: "${actualHostname}"). Connected to LIVE Firebase services.`);
}

// Export Firebase services and specific auth methods/types for convenience
export {
  app,
  auth,
  db,
  storage,
  functions,
  httpsCallable,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,        // Added updateProfile to exports
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,            // Exported deleteDoc
  deleteField,          // Exported for clearing optional fields safely
  writeBatch,           // Exported for atomic multi-doc writes
  collection,
  getDocs,
  onSnapshot,          // Exported onSnapshot
  query,               // Exported query
  where,               // Exported where
  or,                  // Exported or
  orderBy,             // Exported orderBy
  limit,               // Exported for notification query limits
  addDoc,              // Exported for creating notification documents
  storageRef,          // Exported
  uploadBytesResumable, // Exported
  getDownloadURL,      // Exported
  getBlob,             // Exported for CORS-safe blob downloads
  deleteObject,        // Exported for file cleanup
  enableNetwork        // Exported for app resume reconnection
};
export type { FirebaseUser };
