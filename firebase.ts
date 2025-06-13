// firebase.ts

import { initializeApp, getApp, getApps } from 'firebase/app';
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
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
  collection, 
  getDocs,    
  connectFirestoreEmulator,
  onSnapshot, // Added onSnapshot import from Firestore
  query,      // Added query import
  where,      // Added where import
  orderBy     // Added orderBy import
} from 'firebase/firestore';
import { 
  getStorage, 
  connectStorageEmulator,
  ref as storageRef, // Added for explicit naming
  uploadBytesResumable, // Added for uploads
  getDownloadURL      // Added for getting download URLs
} from 'firebase/storage';

// User-provided Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBLmBxkJaImXrB-eOHpaieDTVhcLjOsod0",
  authDomain: "ezyyprint.firebaseapp.com",
  projectId: "ezyyprint",
  storageBucket: "ezyyprint.firebasestorage.app", // Corrected potential typo from .appspot.com to .app
  messagingSenderId: "283831997162",
  appId: "1:283831997162:web:70794657f55abfe91d7d93",
  measurementId: "G-W8E74WXNM3"
};

// Initialize Firebase
let app;
if (!getApps().length) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApp();
}

const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

console.log("[FirebaseConnection] Initializing Firebase services.");

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
console.log(`[FirebaseConnectionDEBUG] viteDevMode (from import.meta.env.DEV): ${viteDevMode}`);

let actualHostname = "unknown_hostname";
try {
  if (typeof window !== 'undefined' && typeof window.location !== 'undefined') {
    actualHostname = window.location.hostname;
  } else {
    console.warn("[FirebaseConnectionDEBUG] window.location.hostname is not available.");
  }
} catch (e) {
    console.error("[FirebaseConnectionDEBUG] Error accessing window.location.hostname:", e);
}
console.log(`[FirebaseConnectionDEBUG] actualHostname (from window.location.hostname): "${actualHostname}"`);

const isLocalHostname = actualHostname === "localhost" || actualHostname === "127.0.0.1";
console.log(`[FirebaseConnectionDEBUG] isLocalHostname (actualHostname === "localhost" || actualHostname === "127.0.0.1"): ${isLocalHostname}`);

const connectToEmulators = viteDevMode || isLocalHostname;
console.log(`[FirebaseConnectionDEBUG] connectToEmulators (viteDevMode || isLocalHostname): ${connectToEmulators}`);


if (connectToEmulators) {
  console.warn(`[FirebaseConnectionDEBUG] ==> DEVELOPMENT-LIKE environment DETECTED (viteDevMode: ${viteDevMode}, actualHostname: "${actualHostname}"). Attempting to connect to Firebase Emulators...`);
  try {
    // Simplified connectAuthEmulator call
    connectAuthEmulator(auth, "http://127.0.0.1:9099"); 
    console.log("[FirebaseConnection] Auth Emulator connection attempt successful to port 9099.");
  } catch (e) {
    console.error("[FirebaseConnection] FAILED to connect Auth Emulator:", e);
  }
  
  try {
    connectFirestoreEmulator(db, "127.0.0.1", 8081);
    console.log("[FirebaseConnection] Firestore Emulator connection attempt successful to port 8081.");
  } catch (e) {
    console.error("[FirebaseConnection] FAILED to connect Firestore Emulator:", e);
  }

  try {
    connectStorageEmulator(storage, "127.0.0.1", 9199);
    console.log("[FirebaseConnection] Storage Emulator connection attempt successful to port 9199.");
  } catch (e) {
    console.error("[FirebaseConnection] FAILED to connect Storage Emulator:", e);
  }
} else {
  console.warn(`[FirebaseConnectionDEBUG] ==> PRODUCTION environment DETECTED (viteDevMode: ${viteDevMode}, actualHostname: "${actualHostname}", isLocalHostname: ${isLocalHostname}). Connecting to LIVE Firebase services.`);
  if (actualHostname === "127.0.0.1" || actualHostname === "localhost") {
    console.error("[FirebaseConnectionDEBUG] CRITICAL LOGIC ERROR: Hostname appears local, but emulators are NOT being connected. This indicates an issue in the detection logic. Logs above should clarify why isLocalHostname or viteDevMode is false.");
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
  signOut, 
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,        // Added updateProfile to exports
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection, 
  getDocs,
  onSnapshot,          // Exported onSnapshot
  query,               // Exported query
  where,               // Exported where
  orderBy,             // Exported orderBy
  storageRef,          // Exported
  uploadBytesResumable, // Exported
  getDownloadURL       // Exported
};
export type { FirebaseUser };