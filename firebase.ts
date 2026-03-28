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
  collection,
  getDocs,
  connectFirestoreEmulator,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,          // Added for capping notification queries
  addDoc,         // Added for creating notification documents
  enableNetwork  // Added for app resume reconnection
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

// Firebase configuration — reads from environment variables (VITE_ prefix for Vite exposure)
// Falls back to hardcoded values if env vars are not set
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyBLmBxkJaImXrB-eOHpaieDTVhcLjOsod0",
  // Use the web.app domain (same as hosting) to prevent cross-origin storage
  // partitioning issues with signInWithRedirect in Android WebViews
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "ezyyprint.web.app",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "ezyyprint",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "ezyyprint.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "283831997162",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:283831997162:web:70794657f55abfe91d7d93",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-W8E74WXNM3"
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


// --- Environment Detection Logic ---
let viteDevMode = false;
try {
  if (typeof import.meta !== 'undefined' && typeof import.meta.env !== 'undefined' && import.meta.env.DEV === true) {
    viteDevMode = true;
  }
} catch (e) {
  console.warn("[FirebaseConnection] Error safely accessing import.meta.env.DEV. Defaulting viteDevMode to false.", e);
  viteDevMode = false;
}

let actualHostname = "unknown_hostname";
try {
  if (typeof window !== 'undefined' && typeof window.location !== 'undefined') {
    actualHostname = window.location.hostname;
  } else {
    console.warn("[FirebaseConnectionDEBUG] window.location.hostname is not available.");
  }
} catch (e) {
}

const isLocalHostname = actualHostname === "localhost" || actualHostname === "127.0.0.1";

// FORCE DISABLE EMULATORS for now to allow connection to live Firebase
// Change this back to `viteDevMode || isLocalHostname` if you want to use local emulators and have started them with `firebase emulators:start`
const connectToEmulators = false;


if (connectToEmulators) {
  console.warn(`[FirebaseConnectionDEBUG] ==> DEVELOPMENT-LIKE environment DETECTED (viteDevMode: ${viteDevMode}, actualHostname: "${actualHostname}"). Attempting to connect to Firebase Emulators...`);
  try {
    // Simplified connectAuthEmulator call
    connectAuthEmulator(auth, "http://127.0.0.1:9099");
  } catch (e) {
  }

  try {
    connectFirestoreEmulator(db, "127.0.0.1", 8081);
  } catch (e) {
  }

  try {
    connectStorageEmulator(storage, "127.0.0.1", 9199);
  } catch (e) {
  }
} else {
  console.log(`[Firebase] Production mode (host: "${actualHostname}"). Connected to LIVE Firebase services.`);
  if (actualHostname === "127.0.0.1" || actualHostname === "localhost") {
    // debugger; // Uncomment this line if you want the script to pause here for inspection
  }
}

// Export Firebase services and specific auth methods/types for convenience
export {
  app,
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
  signInWithEmailAndPassword,
  updateProfile,        // Added updateProfile to exports
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,            // Exported deleteDoc
  collection,
  getDocs,
  onSnapshot,          // Exported onSnapshot
  query,               // Exported query
  where,               // Exported where
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