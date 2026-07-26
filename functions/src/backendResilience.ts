import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import { enforceRateLimit } from "./rateLimit";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

/** Minimal interface for the Firestore Admin gRPC client methods we use. */
interface FirestoreAdminClient {
  databasePath(projectId: string, database: string): string;
  exportDocuments(request: {
    name: string;
    outputUriPrefix: string;
    collectionIds: string[];
  }): Promise<unknown[]>;
  importDocuments(request: {
    name: string;
    inputUriPrefix: string;
    collectionIds: string[];
  }): Promise<unknown[]>;
}

// Firestore Admin Client for backup/restore operations
let firestoreAdminClient: FirestoreAdminClient | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { v1 } = require("@google-cloud/firestore") as { v1: { FirestoreAdminClient: new () => FirestoreAdminClient } };
  firestoreAdminClient = new v1.FirestoreAdminClient();
} catch (e) {
  console.warn("Could not load @google-cloud/firestore. Backups will fail until installed.");
}

// -------------------------------------------------------------------------------- //
// 1. DISASTER RECOVERY & BACKUPS
// -------------------------------------------------------------------------------- //

export const scheduledFirestoreExport = onSchedule(
  {
    schedule: "every day 00:00",
    region: "asia-south1",
    timeoutSeconds: 540, // 9 mins
    serviceAccount: "ezyprint-backup-agent@ezyyprint.iam.gserviceaccount.com"
  },
  async () => {
    if (!firestoreAdminClient) {
      console.error("FirestoreAdminClient not initialized");
      return;
    }

    const projectId = process.env.GCLOUD_PROJECT || "ezyyprint";
    const databaseName = firestoreAdminClient.databasePath(projectId, "(default)");
    const bucketPrefix = `gs://${projectId}-disaster-recovery-backup`;

    try {
      console.log(`Starting automated backup to ${bucketPrefix}`);
      const responses = await firestoreAdminClient.exportDocuments({
        name: databaseName,
        outputUriPrefix: bucketPrefix,
        // Empty collectionIds exports all collections
        collectionIds: []
      });
      
      console.log(`Backup completed successfully: ${JSON.stringify(responses)}`);
      
      // Notify Admin
      await notifyAdmins(
        "Automated Backup Successful ✅",
        `A complete backup of the database was successfully saved to ${bucketPrefix}.`
      );
    } catch (err: unknown) {
      console.error("Automated backup failed", err);
      const errMsg = err instanceof Error ? err.message : String(err);
      // Notify Admin
      await notifyAdmins(
        "⚠️ Automated Backup FAILED",
        `The automated backup to ${bucketPrefix} failed. Error: ${errMsg}`
      );
    }
  }
);

export const restoreCollection = onCall(
  { region: "asia-south1", cors: true, timeoutSeconds: 540 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const adminDoc = await db.collection("users").doc(request.auth.uid).get();
    if (adminDoc.data()?.type !== "ADMIN") throw new HttpsError("permission-denied", "Only admins can restore data.");

    const { otp, collectionName, backupTimestampPath } = request.data;
    if (!otp || !collectionName || !backupTimestampPath) {
      throw new HttpsError("invalid-argument", "otp, collectionName, and backupTimestampPath are required.");
    }

    await verifyAdminOTP(request.auth.uid, otp, "RESTORE_COLLECTION");

    if (!firestoreAdminClient) {
      throw new HttpsError("internal", "FirestoreAdminClient not initialized.");
    }

    const projectId = process.env.GCLOUD_PROJECT || "ezyyprint";
    const databaseName = firestoreAdminClient.databasePath(projectId, "(default)");
    
    // backupTimestampPath looks like: gs://ezyyprint-disaster-recovery-backup/2026-03-29T00:00:00_4343
    try {
      console.log(`Starting restore of collection ${collectionName} from ${backupTimestampPath}`);
      await firestoreAdminClient.importDocuments({
        name: databaseName,
        inputUriPrefix: backupTimestampPath,
        collectionIds: [collectionName]
      });

      // We don't wait for the operation to complete synchronously as it might take a long time on large DBs.
      // But we report that it started.
      return { success: true, message: `Restore operation for ${collectionName} initiated successfully.` };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Restore failed: ${errMsg}`);
      throw new HttpsError("internal", `Restore failed: ${errMsg}`);
    }
  }
);

// Helper to notify all admins
async function notifyAdmins(title: string, body: string) {
  try {
    const admins = await db.collection("users").where("type", "==", "ADMIN").get();
    
    // Note: ideally we would use Nodemailer, but since we're in a separate file, 
    // we can use the notification system or integrate with mailer.
    const batch = db.batch();
    for (const doc of admins.docs) {
      batch.set(db.collection("notifications").doc(), {
         recipientUserId: doc.id,
         message: `${title}: ${body}`,
         type: "info",
         timestamp: new Date().toISOString(),
         read: false
      });
    }
    await batch.commit();
  } catch (err) {
    console.error("Failed to notify admins via Firestore:", err);
  }
}


// -------------------------------------------------------------------------------- //
// 2. SAFE OTP & ACCOUNT DESTROY ORCHESTRATION
// -------------------------------------------------------------------------------- //

export const requestAccountActionOTP = onCall(
  { region: "asia-south1", cors: true, secrets: ["GMAIL_USER", "GMAIL_APP_PASSWORD"] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    await enforceRateLimit({
      key: `account_action_otp:${request.auth.uid}`,
      maxRequests: 3,
      windowMs: 15 * 60 * 1000,
      actionLabel: "account action OTP",
    });

    const callerDoc = await db.collection("users").doc(request.auth.uid).get();
    if (!callerDoc.exists) throw new HttpsError("permission-denied", "User not found.");
    
    const callerData = callerDoc.data()!;
    const email = request.auth.token.email || callerData.email;
    if (!email) throw new HttpsError("failed-precondition", "Account lacks a verified email address.");

    const actionId = request.data.actionId || "ACCOUNT_ACTION";

    // Rate Limiting Check
    const otpDocRef = db.collection("accountActionOtps").doc(request.auth.uid);
    const otpDoc = await otpDocRef.get();
    if (otpDoc.exists && otpDoc.data()?.lockUntil && Date.now() < otpDoc.data()?.lockUntil) {
      const lockRemainingSeconds = Math.ceil((otpDoc.data()!.lockUntil - Date.now()) / 1000);
      throw new HttpsError("resource-exhausted", `Too many failed attempts. Try again in ${lockRemainingSeconds}s.`);
    }

    const nodemailer = await import('nodemailer');
    const crypto = await import('crypto');
    
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER || "",
        pass: process.env.GMAIL_APP_PASSWORD || "",
      },
    });

    const otp = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000;

    await otpDocRef.set({
      otp,
      actionId,
      expiresAt,
      failedAttempts: 0,
    });

    try {
      await transporter.sendMail({
        from: `"EzyPrint Security" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: `Verification Code: ${otp} (Sensitive Action Verification)`,
        text: `You are attempting to perform a sensitive account action. Your verification code is ${otp}. This code expires in 5 minutes.`,
      });
      return { success: true, message: "OTP sent successfully." };
    } catch (err) {
      console.error("Failed to send OTP", err);
      throw new HttpsError("internal", "Failed to send OTP email.");
    }
  }
);

export async function verifyAdminOTP(uid: string, otp: string, actionId: string) {
  const otpDocRef = db.collection("accountActionOtps").doc(uid);
  const otpDoc = await otpDocRef.get();
  
  if (!otpDoc.exists) {
    throw new HttpsError("failed-precondition", "No OTP requested.");
  }
  
  const otpData = otpDoc.data()!;
  
  if (otpData.lockUntil && Date.now() < otpData.lockUntil) {
    throw new HttpsError("resource-exhausted", "Too many attempts. Locked.");
  }
  
  if (Date.now() > otpData.expiresAt) {
    await otpDocRef.delete();
    throw new HttpsError("failed-precondition", "OTP expired.");
  }
  
  if (otpData.otp !== otp || otpData.actionId !== actionId) {
    const attempts = (otpData.failedAttempts || 0) + 1;
    if (attempts >= 3) {
      await otpDocRef.update({ failedAttempts: attempts, lockUntil: Date.now() + 15 * 60 * 1000, otp: "LOCKED" });
      throw new HttpsError("resource-exhausted", "Locked out for 15 minutes due to multiple failures.");
    }
    await otpDocRef.update({ failedAttempts: attempts });
    throw new HttpsError("invalid-argument", "Invalid OTP.");
  }
  
  await otpDocRef.delete();
}

/** Check if suspicious bulk deletes are happening (more than 10 in 60 seconds) */
async function checkSuspiciousBulkActions(adminUid: string) {
  const sixtySecondsAgo = new Date(Date.now() - 60000).toISOString();
  
  // Query only recent entries within the 60-second window, capped at 10
  // This avoids reading the entire audit log which grows unboundedly
  const recentLogs = await db.collection("accountActionAuditLog")
    .where("adminUid", "==", adminUid)
    .where("timestamp", ">=", sixtySecondsAgo)
    .limit(10)
    .get();
    
  const recentCount = recentLogs.size;
    
  if (recentCount >= 10) {
    // Lock the admin
    await db.collection("users").doc(adminUid).update({ isLocked: true });
    
    await db.collection("accountActionAuditLog").add({
      adminUid,
      action: "SUSPICIOUS_BULK_DELETE",
      timestamp: new Date().toISOString(),
      ipAddress: "SYSTEM"
    });
    
    await notifyAdmins(
      "URGENT: Suspicious Bulk Action Detected",
      `Admin ${adminUid} performed >=10 destructive actions in 60s. Admin has been locked.`
    );
    
    throw new HttpsError("resource-exhausted", "Suspicious activity detected. Account locked and reported.");
  }
}

async function cleanupUserData(userId: string) {
  // Cancel active orders
  const pendingOrders = await db.collection("orders").where("userId", "==", userId).where("status", "in", ["PENDING_PAYMENT", "PENDING_APPROVAL", "PRINTING", "READY_FOR_PICKUP"]).get();
  for (const order of pendingOrders.docs) {
     await order.ref.update({ status: "CANCELLED", shopNotes: "Auto-cancelled: User deleted account" });
  }

  // Anonymize associated orders
  const ordersSnap = await db.collection("orders").where("userId", "==", userId).get();
  if (!ordersSnap.empty) {
    let batch = db.batch();
    let operationCount = 0;
    for (const doc of ordersSnap.docs) {
      batch.update(doc.ref, {
        userId: 'deleted_user',
        userName: admin.firestore.FieldValue.delete(),
        email: admin.firestore.FieldValue.delete()
      });
      operationCount++;
      if (operationCount === 500) {
        await batch.commit();
        batch = db.batch();
        operationCount = 0;
      }
    }
    if (operationCount > 0) await batch.commit();
  }

  // Anonymize associated support tickets
  const ticketsSnap = await db.collection("tickets").where("raisedBy", "==", userId).get();
  if (!ticketsSnap.empty) {
    let batch = db.batch();
    let operationCount = 0;
    for (const doc of ticketsSnap.docs) {
      batch.update(doc.ref, {
        raisedBy: 'deleted_user',
        raisedByName: 'Deleted User',
        raisedByEmail: admin.firestore.FieldValue.delete()
      });
      operationCount++;
      if (operationCount === 500) {
        await batch.commit();
        batch = db.batch();
        operationCount = 0;
      }
    }
    if (operationCount > 0) await batch.commit();
  }

  // Hard-delete notifications targeting this user
  const notifsSnap = await db.collection("notifications").where("recipientUserId", "==", userId).get();
  if (!notifsSnap.empty) {
    let batch = db.batch();
    let operationCount = 0;
    for (const doc of notifsSnap.docs) {
      batch.delete(doc.ref);
      operationCount++;
      if (operationCount === 500) {
        await batch.commit();
        batch = db.batch();
        operationCount = 0;
      }
    }
    if (operationCount > 0) await batch.commit();
  }
}

async function deleteCollectionQuery(collectionName: string, field: string, value: string) {
  let snapshot = await db.collection(collectionName).where(field, "==", value).limit(500).get();

  while (!snapshot.empty) {
    const batch = db.batch();
    snapshot.docs.forEach((docSnap) => batch.delete(docSnap.ref));
    await batch.commit();
    snapshot = await db.collection(collectionName).where(field, "==", value).limit(500).get();
  }
}

async function deleteShopSubcollection(shopId: string, subcollection: string) {
  let snapshot = await db.collection("shops").doc(shopId).collection(subcollection).limit(500).get();

  while (!snapshot.empty) {
    const batch = db.batch();
    snapshot.docs.forEach((docSnap) => batch.delete(docSnap.ref));
    await batch.commit();
    snapshot = await db.collection("shops").doc(shopId).collection(subcollection).limit(500).get();
  }
}

async function preserveDeletedShopHistory(shopId: string, archivedShopName: string) {
  const preserveCollectionByShopId = async (collectionName: string) => {
    // Single-pass: fetch all matching docs and mark them.
    // We do NOT re-query because the merge doesn't change shopId,
    // which would cause an infinite loop.
    let lastDoc: admin.firestore.QueryDocumentSnapshot | undefined;
    let hasMore = true;

    while (hasMore) {
      let q = db.collection(collectionName)
        .where("shopId", "==", shopId)
        .where("deletedShop", "!=", true)
        .limit(500);

      if (lastDoc) {
        q = q.startAfter(lastDoc);
      }

      const snapshot = await q.get();
      if (snapshot.empty) {
        hasMore = false;
        continue;
      }

      const batch = db.batch();
      snapshot.docs.forEach((docSnap) => {
        batch.set(docSnap.ref, {
          deletedShop: true,
          shopName: archivedShopName,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      });
      await batch.commit();

      lastDoc = snapshot.docs[snapshot.docs.length - 1];
      hasMore = snapshot.size === 500;
    }
  };

  await preserveCollectionByShopId("orders");
  await preserveCollectionByShopId("tickets");
}

async function cleanupShopOperationalData(shopId: string) {
  await deleteShopSubcollection(shopId, "private");
  await deleteShopSubcollection(shopId, "bankAccessLogs");
  await deleteCollectionQuery("shopLedger", "shopId", shopId);
  await deleteCollectionQuery("payouts", "shopId", shopId);
  await deleteCollectionQuery("refundRequests", "shopId", shopId);
  await deleteCollectionQuery("reactivationRequests", "shopId", shopId);
  await deleteCollectionQuery("notifications", "targetShopId", shopId);
}

export const executeAccountAction = onCall(
  { region: "asia-south1", cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const { otp, action, targetUid } = request.data;
    if (!otp || !action) throw new HttpsError("invalid-argument", "OTP and action type required.");

    const callerDoc = await db.collection("users").doc(request.auth.uid).get();
    const callerData = callerDoc.data();
    
    if (callerData?.isLocked) {
      throw new HttpsError("permission-denied", "Your account is locked due to suspicious activity.");
    }

    const isAdmin = callerData?.type === "ADMIN";
    
    // Verify OTP
    await verifyAdminOTP(request.auth.uid, otp, action);

    const ip = request.rawRequest?.ip || request.rawRequest?.headers['x-forwarded-for'] || "unknown";

    // Route logic
    if (action === "DELETE_USER" || action === "ARCHIVE_USER") {
      if (!isAdmin) throw new HttpsError("permission-denied", "Action requires admin rights.");
      await checkSuspiciousBulkActions(request.auth.uid);
      
      const userId = targetUid;
      if (action === "ARCHIVE_USER") {
        await db.collection("users").doc(userId).update({ isArchived: true });
        // Find their shop
        const shopsSnap = await db.collection("shops").where("ownerUserId", "==", userId).get();
        for (const shop of shopsSnap.docs) {
          await shop.ref.update({ isArchived: true, isOpen: false });
        }
      } else if (action === "DELETE_USER") {
         // Hard-delete shop docs for this user
         const shopsSnap = await db.collection("shops").where("ownerUserId", "==", userId).get();
         for (const shop of shopsSnap.docs) {
           // Cancel pending payouts
           const payouts = await db.collection("payouts").where("shopId", "==", shop.id).get();
           for (const payout of payouts.docs) {
             await payout.ref.update({ status: "DISPUTED", adminNote: "Auto-disputed: User deleted by admin" });
           }
           await preserveDeletedShopHistory(shop.id, shop.data().name || "Archived Shop");
           await cleanupShopOperationalData(shop.id);
           await shop.ref.delete();
         }
         
         await cleanupUserData(userId);

         // Delete Firebase Auth account
         try {
           await admin.auth().deleteUser(userId);
         } catch (e: unknown) {
           if ((e as {code?: string}).code !== 'auth/user-not-found') throw e;
         }
         
         // Hard-delete the user document
         await db.collection("users").doc(userId).delete();
      }

      await db.collection("accountActionAuditLog").add({
        adminUid: request.auth.uid,
        action,
        targetUid,
        timestamp: new Date().toISOString(),
        ipAddress: ip
      });
      return { success: true };
    } 
    
    else if (action === "DELETE_OWN_ACCOUNT" || action === "ARCHIVE_OWN_SHOP") {
      const isShopOwner = callerData?.type === "SHOP_OWNER";
      const isStudent = callerData?.type === "STUDENT";
      if (!isShopOwner && !isStudent) throw new HttpsError("permission-denied", "Invalid user type.");
      
      if (action === "ARCHIVE_OWN_SHOP") {
        // Canonical ownership resolution — do NOT trust targetShopId or callerData.shopId
        const ownedShopsSnap = await db.collection("shops").where("ownerUserId", "==", request.auth.uid).limit(1).get();
        if (ownedShopsSnap.empty) throw new HttpsError("not-found", "No shop found for your account.");
        const ownedShopDoc = ownedShopsSnap.docs[0];
        await ownedShopDoc.ref.update({ isArchived: true, isOpen: false });
      } else if (action === "DELETE_OWN_ACCOUNT") {
         // If shop owner, hard-delete their shop and clean up shop-related data
         if (isShopOwner) {
           const shopsSnap = await db.collection("shops").where("ownerUserId", "==", request.auth.uid).get();
           for (const shop of shopsSnap.docs) {
             const payoutsSnap = await db.collection("payouts").where("shopId", "==", shop.id).get();
             for (const pDoc of payoutsSnap.docs) {
               await pDoc.ref.update({ status: "DISPUTED", adminNote: "Auto-disputed: Shop owner deleted account" });
             }
             await preserveDeletedShopHistory(shop.id, shop.data().name || "Archived Shop");
             await cleanupShopOperationalData(shop.id);
             await shop.ref.delete();
           }
         }
         
         await cleanupUserData(request.auth.uid);

         try {
           await admin.auth().deleteUser(request.auth.uid);
         } catch (e: unknown) {
           if ((e as {code?: string}).code !== 'auth/user-not-found') throw e;
         }
         
         // Hard-delete the user profile document
         await db.collection("users").doc(request.auth.uid).delete();
      }
      
      await db.collection("accountActionAuditLog").add({
        shopkeeperUid: request.auth.uid,
        action,
        timestamp: new Date().toISOString(),
        ipAddress: ip
      });
      return { success: true };
    }

    throw new HttpsError("invalid-argument", "Unsupported action.");
  }
);


/**
 * checkUserExists — Checks if a Firebase Auth account exists for a given UID.
 * Used by admin to determine if a shop's owner is orphaned (deleted their auth account).
 */
export const checkUserExists = onCall(
  { region: "asia-south1", cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    // Only admins can check arbitrary UIDs
    const callerDoc = await db.collection("users").doc(request.auth.uid).get();
    if (callerDoc.data()?.type !== "ADMIN") {
      throw new HttpsError("permission-denied", "Only admins can check user existence.");
    }

    const { uid } = request.data;
    if (!uid) throw new HttpsError("invalid-argument", "uid is required.");

    try {
      await admin.auth().getUser(uid);
      return { exists: true };
    } catch (e: unknown) {
      if ((e as {code?: string}).code === "auth/user-not-found") {
        return { exists: false };
      }
      const errMsg = e instanceof Error ? e.message : String(e);
      throw new HttpsError("internal", `Error checking user: ${errMsg}`);
    }
  }
);

/**
 * checkReturningShopOwner — Checks if an email belongs to an existing shop owner.
 * Returns a richer payload differentiating between:
 *   - Active account (auth exists + shop not archived) → block signup
 *   - Archived shop (auth exists + isArchived) → redirect to sign-in + request reactivation
 *   - Orphaned (auth doesn't exist + shop exists) → treat as fresh signup
 *   - No match → fresh signup
 */
export const checkReturningShopOwner = onCall(
  { region: "asia-south1", cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const email = request.data.email;
    if (!email) throw new HttpsError("invalid-argument", "Email is required.");
    
    // SECURITY VULNERABILITY FIX (Bug 4 - Enum Attack): Enforce identity matching
    if (request.auth.token.email !== email) {
      const callerDoc = await db.collection("users").doc(request.auth.uid).get();
      if (callerDoc.data()?.type !== "ADMIN") {
        throw new HttpsError("permission-denied", "You can only query your own account status.");
      }
    }

    // Query for existing shop owner user documents with this email
    const q = db.collection("users").where("email", "==", email).where("type", "==", "SHOP_OWNER");
    const querySnapshot = await q.get();

    if (querySnapshot.empty) {
      return { exists: false, hasActiveAccount: false, hasArchivedShop: false, isOwnerOrphaned: false };
    }

    const oldUserDoc = querySnapshot.docs[0];
    const oldUserId = oldUserDoc.id;
    const oldUserData = oldUserDoc.data();

    // Check if the old user's Firebase Auth account still exists
    let authAccountExists = false;
    try {
      await admin.auth().getUser(oldUserId);
      authAccountExists = true;
    } catch (e: unknown) {
      if ((e as {code?: string}).code === "auth/user-not-found") {
        authAccountExists = false;
      } else {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.warn(`[checkReturningShopOwner] Error checking auth for ${oldUserId}:`, errMsg);
        authAccountExists = false;
      }
    }

    // If no shopId linked, treat as no match
    if (!oldUserData.shopId) {
      if (!authAccountExists) {
        return { exists: false, hasActiveAccount: false, hasArchivedShop: false, isOwnerOrphaned: true };
      }
      return { exists: true, hasActiveAccount: true, hasArchivedShop: false, isOwnerOrphaned: false };
    }

    // Fetch the linked shop
    const shopDoc = await db.collection("shops").doc(oldUserData.shopId).get();
    if (!shopDoc.exists) {
      // Shop document doesn't exist anymore
      if (!authAccountExists) {
        return { exists: false, hasActiveAccount: false, hasArchivedShop: false, isOwnerOrphaned: true };
      }
      return { exists: true, hasActiveAccount: true, hasArchivedShop: false, isOwnerOrphaned: false };
    }

    const shopData = shopDoc.data()!;
    // SECURITY VULNERABILITY FIX (Bug 4 - Enum Attack): Strip sensitive data, return only what the UI needs
    const sanitizedShop = { id: shopDoc.id, name: shopData.name || 'Shop' };

    if (!authAccountExists) {
      // Auth account deleted → orphaned. Treat as fresh signup.
      return { exists: true, hasActiveAccount: false, hasArchivedShop: false, isOwnerOrphaned: true, shop: sanitizedShop };
    }

    if (shopData.isArchived) {
      // Auth exists but shop is archived
      return { exists: true, hasActiveAccount: false, hasArchivedShop: true, isOwnerOrphaned: false, shop: sanitizedShop };
    }

    // Auth exists and shop is active
    return { exists: true, hasActiveAccount: true, hasArchivedShop: false, isOwnerOrphaned: false, shop: sanitizedShop };
  }
);

/**
 * submitReactivationRequest — Called by a signed-in shopkeeper whose shop is archived.
 * Creates a reactivation request document for admin review.
 */
export const submitReactivationRequest = onCall(
  { region: "asia-south1", cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    await enforceRateLimit({
      key: `reactivation_request:${request.auth.uid}`,
      maxRequests: 3,
      windowMs: 24 * 60 * 60 * 1000,
      actionLabel: "reactivation",
    });

    const { shopId, shopName } = request.data;
    if (!shopId || !shopName) {
      throw new HttpsError("invalid-argument", "shopId and shopName are required.");
    }

    const uid = request.auth.uid;
    const email = request.auth.token.email || "";

    // Verify the shop exists and is actually archived
    const shopDoc = await db.collection("shops").doc(shopId).get();
    if (!shopDoc.exists) {
      throw new HttpsError("not-found", "Shop not found.");
    }
    const shopData = shopDoc.data()!;
    if (!shopData.isArchived) {
      throw new HttpsError("failed-precondition", "This shop is not archived.");
    }
    
    // SECURITY VULNERABILITY FIX (Bug 1 - Overwrite): Explicitly ensure caller is the owner
    if (shopData.ownerUserId !== uid) {
      throw new HttpsError("permission-denied", "You do not have permission to reactivate this shop.");
    }

    // Check for existing pending request to prevent duplicates
    const existingRequests = await db.collection("reactivationRequests")
      .where("shopId", "==", shopId)
      .where("status", "==", "pending")
      .get();

    if (!existingRequests.empty) {
      throw new HttpsError("already-exists", "A reactivation request for this shop is already pending.");
    }

    // Fetch user name
    const userDoc = await db.collection("users").doc(uid).get();
    const userName = userDoc.exists ? (userDoc.data()!.name || "Shop Owner") : "Shop Owner";

    // Create the request
    const requestRef = db.collection("reactivationRequests").doc();
    await requestRef.set({
      id: requestRef.id,
      shopId,
      ownerUid: uid,
      ownerEmail: email,
      ownerName: userName,
      shopName,
      requestedAt: new Date().toISOString(),
      status: "pending",
    });

    // Notify admins
    const adminsSnap = await db.collection("users").where("type", "==", "ADMIN").get();
    const batch = db.batch();
    for (const adminDoc of adminsSnap.docs) {
      const notifRef = db.collection("notifications").doc();
      batch.set(notifRef, {
        message: `Shop "${shopName}" has requested reactivation by ${userName} (${email}).`,
        type: "info",
        recipientUserId: adminDoc.id,
        read: false,
        timestamp: new Date().toISOString(),
      });
    }
    await batch.commit();

    return { success: true, requestId: requestRef.id, message: "Reactivation request submitted. Admin will review it." };
  }
);

/**
 * resolveReactivationRequest — Admin-only, OTP-protected.
 * Approves or rejects a shop reactivation request.
 */
export const resolveReactivationRequest = onCall(
  { region: "asia-south1", cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    const adminDoc = await db.collection("users").doc(request.auth.uid).get();
    if (adminDoc.data()?.type !== "ADMIN") {
      throw new HttpsError("permission-denied", "Only admins can resolve reactivation requests.");
    }

    const { requestId, action, otp, rejectionReason } = request.data;
    if (!requestId || !action || !otp) {
      throw new HttpsError("invalid-argument", "requestId, action, and otp are required.");
    }
    if (action !== "approve" && action !== "reject") {
      throw new HttpsError("invalid-argument", "Action must be 'approve' or 'reject'.");
    }

    // Verify OTP
    await verifyAdminOTP(request.auth.uid, otp, "RESOLVE_REACTIVATION");

    // Fetch the request
    const reqDoc = await db.collection("reactivationRequests").doc(requestId).get();
    if (!reqDoc.exists) {
      throw new HttpsError("not-found", "Reactivation request not found.");
    }
    const reqData = reqDoc.data()!;
    if (reqData.status !== "pending") {
      throw new HttpsError("failed-precondition", `Request already ${reqData.status}.`);
    }

    const now = new Date().toISOString();
    const ip = request.rawRequest?.ip || request.rawRequest?.headers["x-forwarded-for"] || "unknown";

    if (action === "approve") {
      // Re-fetch the real shop data directly mitigating forged reqData payloads
      const shopRef = db.collection("shops").doc(reqData.shopId);
      const shopSnap = await shopRef.get();
      if (!shopSnap.exists) {
        throw new HttpsError("failed-precondition", "Shop no longer exists in registry.");
      }
      const shopData = shopSnap.data()!;
      if (!shopData.isArchived) {
        throw new HttpsError("failed-precondition", "Target shop is not currently archived.");
      }
      if (shopData.ownerUserId !== reqData.ownerUid) {
        throw new HttpsError("permission-denied", "Shop ownership validation failed against target request record.");
      }

      // Unarchive the shop explicitly safely
      await shopRef.update({
        isArchived: false,
        isOpen: false, // Keep closed — shopkeeper can open it themselves
      });
      
      // Formal audit trail log
      await db.collection("accountActionAuditLog").add({
        action: "APPROVE_REACTIVATION",
        adminUid: request.auth.uid,
        adminEmail: request.auth.token.email || "Unknown",
        targetShopId: reqData.shopId,
        targetUid: reqData.ownerUid,
        metadata: { ip, requestActionId: requestId, shopName: reqData.shopName },
        timestamp: now,
      });

      // Ensure the user doc links to this shop
      const userRef = db.collection("users").doc(reqData.ownerUid);
      const userSnap = await userRef.get();
      if (userSnap.exists) {
        await userRef.update({ shopId: reqData.shopId });
      } else {
        // Create user doc if missing (edge case)
        await userRef.set({
          id: reqData.ownerUid,
          email: reqData.ownerEmail,
          name: reqData.ownerName,
          type: "SHOP_OWNER",
          shopId: reqData.shopId,
        });
      }

      // Update request status
      await db.collection("reactivationRequests").doc(requestId).update({
        status: "approved",
        resolvedAt: now,
        resolvedBy: request.auth.uid,
      });

      // Notify the shop owner
      await db.collection("notifications").add({
        message: `Your reactivation request for "${reqData.shopName}" has been approved! You can now manage your shop.`,
        type: "success",
        recipientUserId: reqData.ownerUid,
        targetShopId: reqData.shopId,
        read: false,
        timestamp: now,
      });

    } else {
      // Update request status
      await db.collection("reactivationRequests").doc(requestId).update({
        status: "rejected",
        resolvedAt: now,
        resolvedBy: request.auth.uid,
        rejectionReason: rejectionReason || "No reason provided",
      });

      // Formal audit trail log
      await db.collection("accountActionAuditLog").add({
        action: "REJECT_REACTIVATION",
        adminUid: request.auth.uid,
        adminEmail: request.auth.token.email || "Unknown",
        targetShopId: reqData.shopId,
        targetUid: reqData.ownerUid,
        metadata: { ip, requestActionId: requestId, shopName: reqData.shopName, reason: rejectionReason },
        timestamp: now,
      });

      // Notify the shop owner
      const rejectMsg = rejectionReason
        ? `Your reactivation request for "${reqData.shopName}" was rejected. Reason: ${rejectionReason}`
        : `Your reactivation request for "${reqData.shopName}" was rejected by the admin.`;

      await db.collection("notifications").add({
        message: rejectMsg,
        type: "warning",
        recipientUserId: reqData.ownerUid,
        targetShopId: reqData.shopId,
        read: false,
        timestamp: now,
      });
    }

    // NOTE: Audit log is already written inside each branch above (APPROVE_REACTIVATION / REJECT_REACTIVATION).
    // Removed duplicate unconditional audit write that was creating two entries per action.

    return { success: true, message: `Reactivation request ${action}ed successfully.` };
  }
);
