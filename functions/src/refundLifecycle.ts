import * as functions from "firebase-functions/v1";
import { logger } from "firebase-functions";
import * as admin from "firebase-admin";
import Razorpay from "razorpay";
import { enforceRateLimit } from "./rateLimit";

type FunctionsErrorCode = "ok" | "cancelled" | "unknown" | "invalid-argument" | "deadline-exceeded" |
  "not-found" | "already-exists" | "permission-denied" | "resource-exhausted" | "failed-precondition" |
  "aborted" | "out-of-range" | "unimplemented" | "internal" | "unavailable" | "data-loss" | "unauthenticated";

const V2_ERROR_CODE_MAP: Record<string, FunctionsErrorCode> = {
  "invalid-argument": "invalid-argument",
  "failed-precondition": "failed-precondition",
  "resource-exhausted": "resource-exhausted",
  "unauthenticated": "unauthenticated",
  "permission-denied": "permission-denied",
  "not-found": "not-found",
  "already-exists": "already-exists",
  "aborted": "aborted",
  "internal": "internal",
};

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

let _razorpay: Razorpay | null = null;
function getRazorpay(): Razorpay {
  if (!_razorpay) {
    _razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID || "",
      key_secret: process.env.RAZORPAY_KEY_SECRET || "",
    });
  }
  return _razorpay;
}

// 1. Create Refund Request (Student)
export const createRefundRequest = functions.region("asia-south1").https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be logged in.");
  const authUid = context.auth.uid;

  await enforceRateLimit({
    key: `create_refund:${authUid}`,
    maxRequests: 5,
    windowMs: 15 * 60 * 1000,
    actionLabel: "refund request",
  });

  const { orderId, reason } = data;
  if (!orderId || !reason) throw new functions.https.HttpsError("invalid-argument", "Missing data.");
  const reqRef = db.collection("refundRequests").doc(`refund_${orderId}`);

  await db.runTransaction(async (tx) => {
    const [orderDoc, existingReqDoc] = await Promise.all([
      tx.get(db.collection("orders").doc(orderId)),
      tx.get(reqRef),
    ]);

    if (!orderDoc.exists) throw new functions.https.HttpsError("not-found", "Order not found.");
    if (existingReqDoc.exists) {
      throw new functions.https.HttpsError("already-exists", "Refund request already exists.");
    }

    const orderData = orderDoc.data()!;
    if (orderData.userId !== authUid) {
      throw new functions.https.HttpsError("permission-denied", "Not your order.");
    }
    if (orderData.status !== "COMPLETED") {
      throw new functions.https.HttpsError("failed-precondition", "Only COMPLETED orders can be refunded.");
    }

    // Check 5-day window
    // Use createdAt / uploadedAt as fallback if completedAt / paymentAttemptedAt are missing on legacy orders
    const completionTimeMs = orderData.completedAt ? new Date(orderData.completedAt).getTime() :
      (orderData.paymentAttemptedAt ? new Date(orderData.paymentAttemptedAt).getTime() :
      (orderData.createdAt ? new Date(orderData.createdAt).getTime() :
      (orderData.uploadedAt ? new Date(orderData.uploadedAt).getTime() : 0)));

    if (completionTimeMs === 0) {
      throw new functions.https.HttpsError("failed-precondition", "Refunds cannot be requested for malformed orders lacking timestamps.");
    }

    if (Date.now() - completionTimeMs > 5 * 24 * 60 * 60 * 1000) {
      throw new functions.https.HttpsError("failed-precondition", "Refunds can only be requested within 5 days of completion.");
    }

    tx.create(reqRef, {
      id: reqRef.id,
      orderId,
      studentId: authUid,
      shopId: orderData.shopId,
      reason,
      status: "PENDING_SHOP",
      studentRequestedAt: new Date().toISOString()
    });
  });

  return { success: true, requestId: reqRef.id };
});

// 2. Respond to Refund Request (Shop)
export const respondToRefundRequest = functions.region("asia-south1").https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be logged in.");

  await enforceRateLimit({
    key: `respond_refund:${context.auth.uid}`,
    maxRequests: 10,
    windowMs: 15 * 60 * 1000,
    actionLabel: "refund response",
  });

  const { requestId, approved, shopResponse } = data;
  if (!requestId || approved === undefined) throw new functions.https.HttpsError("invalid-argument", "Missing data.");

  const reqRef = db.collection("refundRequests").doc(requestId);
  const reqDoc = await reqRef.get();
  if (!reqDoc.exists) throw new functions.https.HttpsError("not-found", "Request not found.");

  const reqData = reqDoc.data()!;

  // State machine guard: only respond to requests that are still awaiting shop action
  if (reqData.status !== "PENDING_SHOP") {
    throw new functions.https.HttpsError("failed-precondition", "This refund request is no longer in a state that allows a shop response.");
  }

  const shopDoc = await db.collection("shops").doc(reqData.shopId).get();
  if (shopDoc.data()?.ownerUserId !== context.auth.uid) {
    throw new functions.https.HttpsError("permission-denied", "Not your shop's refund request.");
  }

  await reqRef.update({
    status: approved ? "APPROVED_BY_SHOP" : "REJECTED_BY_SHOP",
    shopResponse: shopResponse || "",
    shopRespondedAt: new Date().toISOString()
  });

  // If approved, trigger actual refund (would call existing refund logic)
  // For now we assume if approved it awaits admin or system resolution.

  return { success: true };
});

// 3. Escalate Refund Request (Student)
export const escalateRefundRequest = functions.region("asia-south1").https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be logged in.");

  await enforceRateLimit({
    key: `escalate_refund:${context.auth.uid}`,
    maxRequests: 5,
    windowMs: 15 * 60 * 1000,
    actionLabel: "refund escalation",
  });

  const { requestId } = data;
  if (!requestId) throw new functions.https.HttpsError("invalid-argument", "Missing data.");

  const reqRef = db.collection("refundRequests").doc(requestId);
  const reqDoc = await reqRef.get();
  if (!reqDoc.exists) throw new functions.https.HttpsError("not-found", "Request not found.");

  if (reqDoc.data()!.studentId !== context.auth.uid) {
    throw new functions.https.HttpsError("permission-denied", "Not your request.");
  }

  if (reqDoc.data()!.status !== "REJECTED_BY_SHOP") {
    throw new functions.https.HttpsError("failed-precondition", "Can only escalate rejected requests.");
  }

  await reqRef.update({
    status: "ESCALATED_TO_ADMIN"
  });

  return { success: true };
});

// 4. Auto-escalate Refund Requests (Scheduled)
export const autoEscalateRefundRequests = functions.region("asia-south1").pubsub.schedule("every 12 hours").onRun(async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let totalEscalated = 0;
  let hasMoreRequests = true;

  while (hasMoreRequests) {
    const snapshot = await db.collection("refundRequests")
      .where("status", "==", "PENDING_SHOP")
      .where("studentRequestedAt", "<=", cutoff)
      .limit(250)
      .get();

    if (snapshot.empty) {
      hasMoreRequests = false;
      continue;
    }

    const batch = db.batch();
    snapshot.docs.forEach(doc => {
      batch.update(doc.ref, {
        status: "AUTO_ESCALATED"
      });
    });

    await batch.commit();
    totalEscalated += snapshot.size;

    hasMoreRequests = snapshot.size === 250;
  }

  logger.info(`Auto-escalated ${totalEscalated} refund requests.`);
});

// 5. Auto-close Resolved refund requests and tickets (Scheduled)
export const autoCloseResolvedTickets = functions.region("asia-south1").pubsub.schedule("every 24 hours").onRun(async () => {
  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  let totalClosed = 0;
  let hasMoreTickets = true;

  while (hasMoreTickets) {
    const resolvedTickets = await db.collection("tickets")
      .where("status", "==", "RESOLVED")
      .where("updatedAt", "<=", cutoff)
      .limit(100)
      .get();

    if (resolvedTickets.empty) {
      hasMoreTickets = false;
      continue;
    }

    const batch = db.batch();
    for (const doc of resolvedTickets.docs) {
      batch.update(doc.ref, {
        status: "CLOSED",
        updatedAt: new Date().toISOString(),
      });
    }
    await batch.commit();
    totalClosed += resolvedTickets.size;

    hasMoreTickets = resolvedTickets.size === 100;
  }

  if (totalClosed > 0) {
    logger.info(`Auto-closed ${totalClosed} resolved support tickets.`);
  } else {
    logger.info("No-op for autoClose — no tickets matched condition.");
  }
});

type RefundPreparationMode = "VOID_PENDING" | "DEDUCT_SETTLED";

interface RefundPreparationState {
  shopLedgerBalanceBefore: number;
  shopPendingBalanceBefore: number;
  shopDebtAmountBefore: number;
  shopFinancialVersionBefore: number;
  orderStatusBefore: string;
  orderRefundStatusBefore?: string;
  orderRefundIdBefore?: string;
  orderRefundAmountBefore?: number;
  orderRefundedAtBefore?: string;
  orderRefundErrorBefore?: string;
  orderRefundReasonBefore?: string;
  orderRefundInitiatedByBefore?: string;
  creditEntryId?: string;
  creditEntryStatusBefore?: string;
  feeDeductionAmount: number;
  mode: RefundPreparationMode;
}

function restoreField<T>(value: T | undefined | null) {
  return (value === undefined || value === null) ? admin.firestore.FieldValue.delete() : value;
}

function applySettledRefundDeduction(params: {
  ledgerBalance: number;
  debtAmount: number;
  deductionAmount: number;
}) {
  const { ledgerBalance, debtAmount, deductionAmount } = params;
  const clampedLedgerBalance = Math.max(0, ledgerBalance);
  const remainingAfterLedger = Math.max(0, deductionAmount - clampedLedgerBalance);

  return {
    nextLedgerBalance: Math.max(0, clampedLedgerBalance - deductionAmount),
    nextDebtAmount: debtAmount + remainingAfterLedger,
  };
}

async function rollbackPreparedRefund(params: {
  intentRef: admin.firestore.DocumentReference;
  orderRef: admin.firestore.DocumentReference;
  orderId: string;
  shopId: string;
  rollbackState: RefundPreparationState;
  reqId?: string;
  errorMessage: string;
}) {
  const { intentRef, orderRef, orderId, shopId, rollbackState, errorMessage } = params;
  const shopRef = db.collection("shops").doc(shopId);

  await db.runTransaction(async (tx) => {
    const intentSnap = await tx.get(intentRef);
    if (!intentSnap.exists) {
      return;
    }

    const intentData = intentSnap.data();
    if (intentData?.status === "SUCCESS" || intentData?.status === "API_REFUND_CREATED") {
      return;
    }

    tx.update(shopRef, {
      ledgerBalance: rollbackState.shopLedgerBalanceBefore,
      pendingBalance: rollbackState.shopPendingBalanceBefore,
      debtAmount: rollbackState.shopDebtAmountBefore,
      financialVersion: rollbackState.shopFinancialVersionBefore,
    });

    if (rollbackState.creditEntryId && rollbackState.creditEntryStatusBefore) {
      tx.update(db.collection("shopLedger").doc(rollbackState.creditEntryId), {
        status: rollbackState.creditEntryStatusBefore,
      });
    }

    tx.update(orderRef, {
      status: rollbackState.orderStatusBefore,
      refundStatus: "FAILED",
      refundError: errorMessage,
      refundReason: restoreField(rollbackState.orderRefundReasonBefore),
      refundInitiatedBy: restoreField(rollbackState.orderRefundInitiatedByBefore),
      refundId: restoreField(rollbackState.orderRefundIdBefore),
      refundAmount: restoreField(rollbackState.orderRefundAmountBefore),
      refundedAt: restoreField(rollbackState.orderRefundedAtBefore),
      refundProcessingStartedAt: admin.firestore.FieldValue.delete(),
    });

    tx.delete(db.collection("shopLedger").doc(`refund_${orderId}`));

    tx.update(intentRef, {
      status: "FAILED",
      lastError: errorMessage,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      apiLockUntilMs: admin.firestore.FieldValue.delete(),
    });
  });
}

/**
 * Core Orchestration: Safely executes a refund, securing idempotency and unwinding the financial ledger.
 */
export async function executeSafeRefund(params: {
  orderId: string;
  razorpayPaymentId: string;
  shopId: string;
  reason: string;
  actorUid: string;
  source: 'ADMIN' | 'SYSTEM';
  ipAddress: string;
  // Optional: If this was triggered via a manual refund request that needs updating
  reqId?: string;
  adminNote?: string;
}): Promise<{ success: boolean; message: string }> {
  const { orderId, razorpayPaymentId, shopId, reason, actorUid, source, ipAddress, reqId, adminNote } = params;
  
  const orderRef = db.collection("orders").doc(orderId);
  const idempotencyKey = `refund_${orderId}`;
  const intentRef = db.collection("refundIntents").doc(idempotencyKey);
  const INIT_TIMEOUT_MS = 5 * 60 * 1000;
  const nowServer = admin.firestore.FieldValue.serverTimestamp();
  const nowMs = Date.now();

  let existingRefundId: string | null = null;
  let feeDeductionAmount = 0;
  let rollbackState: RefundPreparationState | null = null;
  let razorpayApiSucceeded = false;

  // 1. Prepare Firestore state FIRST, before touching Razorpay.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(intentRef);
    if (snap.exists) {
      const data = snap.data();
      if (data?.status === "SUCCESS") {
        throw new functions.https.HttpsError("already-exists", "Refund already processed.");
      }
      if (data?.status === "PREPARED" && data?.apiLockUntilMs && nowMs < data.apiLockUntilMs) {
        throw new functions.https.HttpsError("already-exists", "Refund already in progress.");
      }
      if (data?.status === "API_REFUND_CREATED" && data?.razorpayRefundId) {
        existingRefundId = data.razorpayRefundId;
        rollbackState = data.rollbackState as RefundPreparationState;
        feeDeductionAmount = data.feeDeductionAmount || 0;
        tx.update(intentRef, {
          updatedAt: nowServer,
          attemptCount: admin.firestore.FieldValue.increment(1),
        });
        return;
      }
    }

    const currentOrder = await tx.get(orderRef);
    if (!currentOrder.exists) {
      throw new functions.https.HttpsError("not-found", "Order not found.");
    }

    const currentOrderData = currentOrder.data()!;
    if (currentOrderData.refundId && currentOrderData.refundStatus !== "FAILED") {
      throw new functions.https.HttpsError("already-exists", "Refund already processed.");
    }

    feeDeductionAmount = currentOrderData?.priceDetails?.pageCost || 0;

    const shopRef = db.collection("shops").doc(shopId);
    const shopDoc = await tx.get(shopRef);
    if (!shopDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Shop not found.");
    }

    const ledgerBalance = shopDoc.data()?.ledgerBalance || 0;
    const pendingBalance = shopDoc.data()?.pendingBalance || 0;
    const debtAmount = shopDoc.data()?.debtAmount || 0;
    const financialVersion = shopDoc.data()?.financialVersion || 0;
    const ledgerEntryId = currentOrderData?.ledgerEntryId;

    rollbackState = {
      shopLedgerBalanceBefore: ledgerBalance,
      shopPendingBalanceBefore: pendingBalance,
      shopDebtAmountBefore: debtAmount,
      shopFinancialVersionBefore: financialVersion,
      orderStatusBefore: currentOrderData.status ?? null,
      orderRefundStatusBefore: currentOrderData.refundStatus ?? null,
      orderRefundIdBefore: currentOrderData.refundId ?? null,
      orderRefundAmountBefore: currentOrderData.refundAmount ?? null,
      orderRefundedAtBefore: currentOrderData.refundedAt ?? null,
      orderRefundErrorBefore: currentOrderData.refundError ?? null,
      orderRefundReasonBefore: currentOrderData.refundReason ?? null,
      orderRefundInitiatedByBefore: currentOrderData.refundInitiatedBy ?? null,
      feeDeductionAmount,
      mode: "DEDUCT_SETTLED",
    };

    let handled = false;

    if (ledgerEntryId) {
      const creditEntryRef = db.collection("shopLedger").doc(ledgerEntryId);
      const creditEntry = await tx.get(creditEntryRef);
      if (creditEntry.exists && creditEntry.data()?.status === "PENDING" && creditEntry.data()?.amount === feeDeductionAmount) {
        rollbackState.creditEntryId = creditEntryRef.id;
        rollbackState.creditEntryStatusBefore = creditEntry.data()?.status;
        rollbackState.mode = "VOID_PENDING";
        tx.update(creditEntryRef, { status: "VOID" });
        tx.update(shopRef, {
          pendingBalance: Math.max(0, pendingBalance - feeDeductionAmount),
          financialVersion: admin.firestore.FieldValue.increment(1),
        });
        handled = true;
      } else if (creditEntry.exists && creditEntry.data()?.status === "SETTLED") {
        rollbackState.creditEntryId = creditEntryRef.id;
        rollbackState.creditEntryStatusBefore = creditEntry.data()?.status;
        rollbackState.mode = "DEDUCT_SETTLED";
        const { nextLedgerBalance, nextDebtAmount } = applySettledRefundDeduction({
          ledgerBalance,
          debtAmount,
          deductionAmount: feeDeductionAmount,
        });
        tx.update(shopRef, {
          ledgerBalance: nextLedgerBalance,
          debtAmount: nextDebtAmount,
          financialVersion: admin.firestore.FieldValue.increment(1),
        });
        handled = true;
      }
    }

    if (!handled) {
      const creditQuery = db.collection("shopLedger")
        .where("orderId", "==", orderId)
        .where("type", "==", "ORDER_EARNING")
        .limit(1);
      const creditSnap = await tx.get(creditQuery);

      if (!creditSnap.empty) {
        const creditDoc = creditSnap.docs[0];
        rollbackState.creditEntryId = creditDoc.id;
        rollbackState.creditEntryStatusBefore = creditDoc.data().status;
        if (creditDoc.data().status === "PENDING") {
          rollbackState.mode = "VOID_PENDING";
          tx.update(creditDoc.ref, { status: "VOID" });
          tx.update(shopRef, {
            pendingBalance: Math.max(0, pendingBalance - feeDeductionAmount),
            financialVersion: admin.firestore.FieldValue.increment(1),
          });
          handled = true;
        }
      }
    }

    if (!handled) {
      rollbackState.mode = "DEDUCT_SETTLED";
      const { nextLedgerBalance, nextDebtAmount } = applySettledRefundDeduction({
        ledgerBalance,
        debtAmount,
        deductionAmount: feeDeductionAmount,
      });
      tx.update(shopRef, {
        ledgerBalance: nextLedgerBalance,
        debtAmount: nextDebtAmount,
        financialVersion: admin.firestore.FieldValue.increment(1),
      });
    }

    tx.update(orderRef, {
      refundStatus: "PROCESSING_INTERNAL",
      refundReason: reason,
      refundInitiatedBy: source,
      refundError: admin.firestore.FieldValue.delete(),
      refundProcessingStartedAt: new Date().toISOString(),
    });

    if (snap.exists) {
      tx.update(intentRef, {
        requestId: reqId || "AUTO_CANCEL",
        status: "PREPARED",
        feeDeductionAmount,
        rollbackState,
        updatedAt: nowServer,
        apiLockUntilMs: nowMs + INIT_TIMEOUT_MS,
        attemptCount: admin.firestore.FieldValue.increment(1),
      });
    } else {
      tx.create(intentRef, {
        orderId,
        shopId,
        requestId: reqId || "AUTO_CANCEL",
        status: "PREPARED",
        feeDeductionAmount,
        rollbackState,
        createdAt: nowServer,
        updatedAt: nowServer,
        apiLockUntilMs: nowMs + INIT_TIMEOUT_MS,
        attemptCount: 1,
      });
    }
  });

  try {
    let refund;
    // 2. Execute Razorpay refund ONLY after Firestore preparation succeeds.
    if (existingRefundId) {
      refund = await getRazorpay().refunds.fetch(existingRefundId);
    } else {
      refund = await getRazorpay().payments.refund(razorpayPaymentId, {
        speed: "normal",
        notes: {
          orderId,
          refundAttemptId: idempotencyKey,
          reason,
          initiatedBy: actorUid,
          source,
        },
      });

      await intentRef.update({
        status: "API_REFUND_CREATED",
        razorpayRefundId: refund.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        apiLockUntilMs: admin.firestore.FieldValue.delete(),
      });
    }
    razorpayApiSucceeded = true;

    // 3. Finalize Firestore state after external refund succeeds.
    await db.runTransaction(async (tx) => {
      const intentSnap = await tx.get(intentRef);
      if (intentSnap.data()?.status === "SUCCESS") return;

      const currentOrder = await tx.get(orderRef);
      if (currentOrder.data()?.refundId && currentOrder.data()?.refundStatus !== "FAILED") return;

      // Mandatory REFUND_DEDUCTION entry
      const debitRef = db.collection("shopLedger").doc(`refund_${orderId}`);
      tx.set(debitRef, {
        id: debitRef.id,
        eventId: idempotencyKey,
        shopId,
        orderId,
        type: "REFUND_DEDUCTION",
        status: "SETTLED",
        amount: -feeDeductionAmount,
        counterparty: "STUDENT",
        description: `Refund deduction for order #${orderId.slice(-6)}`,
        createdBy: source,
        createdAt: new Date().toISOString()
      });

      // Update Order Status
      tx.update(orderRef, {
        status: "REFUNDED",
        refundId: refund.id,
        refundStatus: refund.status || "processed",
        refundAmount: refund.amount ? refund.amount / 100 : 0,
        refundedAt: new Date().toISOString(),
        refundError: admin.firestore.FieldValue.delete(),
        refundProcessingStartedAt: admin.firestore.FieldValue.delete(),
      });

      // Update Refund Request (If applicable)
      if (reqId) {
        tx.update(db.collection("refundRequests").doc(reqId), {
          status: "RESOLVED_REFUNDED",
          adminNote: adminNote || "",
          adminResolvedAt: new Date().toISOString(),
          resolvedBy: actorUid
        });
      }

      // Finalize Lock
      tx.update(intentRef, {
        status: 'SUCCESS',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        apiLockUntilMs: admin.firestore.FieldValue.delete(),
      });
    });

    // 4. Uniform Audit Log
    await db.collection("accountActionAuditLog").add({
      adminUid: actorUid,
      source: source,
      action: "RESOLVE_REFUND_REQUEST",
      orderId: orderId,
      refundId: refund.id,
      amount: refund.amount ? refund.amount / 100 : 0,
      reason: reason,
      timestamp: new Date().toISOString(),
      ipAddress: ipAddress,
    });

    return { success: true, message: "Refund processed safely." };

  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to process refund.";

    if (!razorpayApiSucceeded && rollbackState) {
      try {
        await rollbackPreparedRefund({
          intentRef,
          orderRef,
          orderId,
          shopId,
          rollbackState,
          reqId,
          errorMessage: message,
        });
      } catch (rollbackErr) {
        logger.error("REFUND_ROLLBACK_FAILED", { orderId, error: String(rollbackErr) });
        try {
          await intentRef.update({
            status: "ROLLBACK_FAILED",
            lastError: message,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            apiLockUntilMs: admin.firestore.FieldValue.delete(),
          });
        } catch (cleanupErr) {
          logger.error("REFUND_INTENT_CLEANUP_FAILED", { orderId, error: String(cleanupErr) });
        }
      }
    } else {
      try {
        await intentRef.update({
          status: "API_REFUND_CREATED",
          lastError: message,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          apiLockUntilMs: admin.firestore.FieldValue.delete(),
        });
      } catch (cleanupErr) {
        logger.error("REFUND_INTENT_CLEANUP_FAILED", { orderId, error: String(cleanupErr) });
      }
    }

    if (err instanceof functions.https.HttpsError) throw err;
    throw new functions.https.HttpsError("internal", message);
  }
}

// 6. Resolve Refund Request (Admin)
export const resolveRefundRequest = functions.region("asia-south1").https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be logged in.");

  const callerDoc = await db.collection("users").doc(context.auth.uid).get();
  if (callerDoc.data()?.type !== "ADMIN") {
    throw new functions.https.HttpsError("permission-denied", "Only admins can resolve refund requests.");
  }

  const { requestId, action, adminNote, otp } = data;
  if (!requestId || !action) throw new functions.https.HttpsError("invalid-argument", "Missing data.");

  // Gated behind absolute OTP lock
  if (!otp) throw new functions.https.HttpsError("invalid-argument", "OTP is required.");
  try {
    const { verifyAdminOTP } = await import("./backendResilience");
    await verifyAdminOTP(context.auth.uid, otp, "RESOLVE_REFUND_REQUEST");
  } catch (otpErr: unknown) {
    // Re-map v2 HttpsError to v1 so the structured code reaches the client
    const err = otpErr as { code?: string; httpErrorCode?: { status: number }; message?: string };
    const rawCode = err.code || "internal";
    const mappedCode: FunctionsErrorCode = V2_ERROR_CODE_MAP[rawCode] || "internal";
    const message = err.message || "OTP verification failed.";
    throw new functions.https.HttpsError(mappedCode, message);
  }

  const reqRef = db.collection("refundRequests").doc(requestId);
  const reqDoc = await reqRef.get();
  if (!reqDoc.exists) throw new functions.https.HttpsError("not-found", "Request not found.");

  const reqData = reqDoc.data()!;
  if (!["ESCALATED_TO_ADMIN", "AUTO_ESCALATED", "PENDING_SHOP", "APPROVED_BY_SHOP"].includes(reqData.status)) {
    throw new functions.https.HttpsError("failed-precondition", "Request is not in a resolvable state.");
  }

  if (action === "DENY") {
    await db.runTransaction(async (tx) => {
      tx.update(reqRef, {
        status: "RESOLVED_DENIED",
        adminNote: adminNote || "",
        adminResolvedAt: new Date().toISOString(),
        resolvedBy: context.auth!.uid
      });
    });
    
    await db.collection("accountActionAuditLog").add({
      adminUid: context.auth.uid,
      source: "ADMIN",
      action: "DENY_REFUND_REQUEST",
      requestId: requestId,
      orderId: reqData.orderId,
      reason: adminNote || "Admin denied manually",
      timestamp: new Date().toISOString(),
      ipAddress: context.rawRequest?.ip || context.rawRequest?.headers["x-forwarded-for"] || "unknown",
    });
    return { success: true, message: "Refund request denied." };
  }

  if (action === "APPROVE") {
    const orderDoc = await db.collection("orders").doc(reqData.orderId).get();
    if (!orderDoc.exists) throw new functions.https.HttpsError("not-found", "Order not found.");
    const orderData = orderDoc.data()!;

    if (!orderData.razorpayPaymentId) {
      throw new functions.https.HttpsError("failed-precondition", "Order has no captured payment to refund.");
    }
    if (orderData.refundId && orderData.refundStatus !== "FAILED") {
      throw new functions.https.HttpsError("already-exists", "Refund already issued for this order.");
    }

    return await executeSafeRefund({
      orderId: reqData.orderId,
      razorpayPaymentId: orderData.razorpayPaymentId,
      shopId: orderData.shopId,
      reason: adminNote || reqData.reason || "Admin-approved refund request",
      actorUid: context.auth.uid,
      source: "ADMIN",
      ipAddress: Array.isArray(context.rawRequest?.headers["x-forwarded-for"]) 
                ? context.rawRequest?.headers["x-forwarded-for"][0] 
                : context.rawRequest?.headers["x-forwarded-for"] || context.rawRequest?.ip || "unknown",
      reqId: requestId,
      adminNote: adminNote
    });
  }

  throw new functions.https.HttpsError("invalid-argument", "Invalid action.");
});

// 7. Shop Initiate Refund (from Support Ticket)
export const shopInitiateRefund = functions.region("asia-south1").https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be logged in.");

  await enforceRateLimit({
    key: `shop_refund:${context.auth.uid}`,
    maxRequests: 5,
    windowMs: 15 * 60 * 1000,
    actionLabel: "shop refund initiation",
  });

  const { orderId, reason, ticketId } = data;
  if (!orderId || !ticketId) throw new functions.https.HttpsError("invalid-argument", "Missing data.");

  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) throw new functions.https.HttpsError("not-found", "Order not found.");
  const orderData = orderDoc.data()!;

  const ticketDoc = await db.collection("tickets").doc(ticketId).get();
  if (!ticketDoc.exists) throw new functions.https.HttpsError("not-found", "Ticket not found.");
  const ticketData = ticketDoc.data()!;

  if (ticketData.relatedOrderId !== orderId) {
    throw new functions.https.HttpsError("invalid-argument", "Ticket does not match the provided order.");
  }

  const shopDoc = await db.collection("shops").doc(orderData.shopId).get();
  if (shopDoc.data()?.ownerUserId !== context.auth.uid || ticketData.shopId !== orderData.shopId) {
    throw new functions.https.HttpsError("permission-denied", "Not your shop's order or ticket.");
  }

  if (!orderData.razorpayPaymentId || orderData.status === "PENDING_PAYMENT" || orderData.status === "PAYMENT_FAILED") {
    throw new functions.https.HttpsError("failed-precondition", "Order is not paid or not in a refundable state.");
  }

  // 1. Check 5-day refund window (must apply to shop-initiated refunds too)
  const completionTimeMs = orderData.completedAt ? new Date(orderData.completedAt).getTime() : 
                        (orderData.paymentAttemptedAt ? new Date(orderData.paymentAttemptedAt).getTime() : 
                        (orderData.createdAt ? new Date(orderData.createdAt).getTime() : 0));
  
  if (completionTimeMs === 0) {
    throw new functions.https.HttpsError("failed-precondition", "Refunds cannot be requested for malformed orders lacking timestamps.");
  }

  if (Date.now() - completionTimeMs > 5 * 24 * 60 * 60 * 1000) {
    throw new functions.https.HttpsError("failed-precondition", "Refunds can only be requested within 5 days of completion.");
  }

  if (orderData.refundId && orderData.refundStatus !== "FAILED") {
    throw new functions.https.HttpsError("already-exists", "Refund already processed for this order.");
  }

  // 2. Query legacy random-id requests
  const existingReqs = await db.collection("refundRequests").where("orderId", "==", orderId).get();
  if (!existingReqs.empty) {
    throw new functions.https.HttpsError("already-exists", "A refund request already exists for this order.");
  }

  // 3. Create a pre-approved refund request using a deterministic ID to prevent races
  // .create() will atomically fail if two concurrent requests try to use the same ID
  const reqRefId = `req_${orderId}`;
  const reqRef = db.collection("refundRequests").doc(reqRefId);
  
  try {
    await reqRef.create({
      id: reqRefId,
      orderId,
      studentId: orderData.userId,
      shopId: orderData.shopId,
      reason: reason || `Shop initiated refund from Ticket #${ticketId.slice(-6)}`,
      status: "APPROVED_BY_SHOP", // Bypasses PENDING_SHOP
      studentRequestedAt: new Date().toISOString(),
      shopRespondedAt: new Date().toISOString(),
      ticketId
    });
  } catch (err: unknown) {
    const error = err as { code?: number; message?: string };
    if (error.code === 6 || error.message?.includes('ALREADY_EXISTS')) {
      throw new functions.https.HttpsError("already-exists", "A refund request already exists for this order.");
    }
    throw err;
  }

  return { success: true, requestId: reqRefId };
});

// 8. Escalate Ticket to Admin (Student)
export const escalateTicketToAdmin = functions.region("asia-south1").https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be logged in.");

  await enforceRateLimit({
    key: `escalate_ticket:${context.auth.uid}`,
    maxRequests: 5,
    windowMs: 15 * 60 * 1000,
    actionLabel: "ticket escalation",
  });

  const { ticketId, reason } = data;
  if (!ticketId) throw new functions.https.HttpsError("invalid-argument", "Missing data.");

  const ticketRef = db.collection("tickets").doc(ticketId);
  const ticketDoc = await ticketRef.get();
  if (!ticketDoc.exists) throw new functions.https.HttpsError("not-found", "Ticket not found.");

  const ticketData = ticketDoc.data()!;
  if (ticketData.raisedBy !== context.auth.uid) {
    throw new functions.https.HttpsError("permission-denied", "Not your ticket.");
  }

  if (ticketData.status !== "CLOSED" && ticketData.status !== "RESOLVED") {
    throw new functions.https.HttpsError("failed-precondition", "Can only escalate closed or resolved tickets.");
  }

  const now = new Date().toISOString();
  
  const escalationMsg = {
    id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    senderId: context.auth.uid,
    senderName: ticketData.raisedByName || "Student",
    senderType: "STUDENT",
    message: `🚨 ESCALATED TO ADMIN 🚨\nReason: ${reason || "User requested admin intervention."}`,
    timestamp: now
  };

  const statusChange = {
    from: ticketData.status,
    to: "IN_REVIEW",
    changedBy: context.auth.uid,
    changedByName: ticketData.raisedByName || "Student",
    timestamp: now,
    note: "Ticket escalated to Admin"
  };

  await ticketRef.update({
    status: "IN_REVIEW", // Set back to OPEN/IN_REVIEW for Admin attention
    updatedAt: now,
    messages: admin.firestore.FieldValue.arrayUnion(escalationMsg),
    statusHistory: admin.firestore.FieldValue.arrayUnion(statusChange)
  });

  return { success: true };
});

// 9. Synchronize Live Refund History from Razorpay (Admin Only)
export const syncRefundHistory = functions.region("asia-south1").https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be logged in.");

  // Verify Admin
  const callerDoc = await db.collection("users").doc(context.auth.uid).get();
  if (callerDoc.data()?.type !== "ADMIN") {
    throw new functions.https.HttpsError("permission-denied", "Only admins can query live refund history directly from Razorpay.");
  }

  const { orderId } = data;
  if (!orderId) throw new functions.https.HttpsError("invalid-argument", "Missing orderId.");

  const orderRef = db.collection("orders").doc(orderId);
  const orderDoc = await orderRef.get();
  if (!orderDoc.exists) throw new functions.https.HttpsError("not-found", "Order not found.");

  const orderData = orderDoc.data()!;
  if (!orderData.razorpayPaymentId) {
    throw new functions.https.HttpsError("failed-precondition", "Order has no Razorpay Payment ID associated with it.");
  }

  try {
    // Fetch all refunds associated with this specific payment from Razorpay (Bypassing Razorpay's broken TS definitions)
    const refundsData = await getRazorpay().refunds.all({
      payment_id: orderData.razorpayPaymentId
    } as unknown as Record<string, unknown>) as Record<string, unknown>;

    // If there are refunds, optionally update the local order status dynamically
    if (refundsData && Array.isArray(refundsData.items) && refundsData.items.length > 0) {
      // Sort to get the most recent refund
      const refunds = refundsData.items.sort((a: Record<string, unknown>, b: Record<string, unknown>) => (b.created_at as number) - (a.created_at as number));
      const latestRefund = refunds[0] as Record<string, unknown>;

      if (latestRefund.status !== orderData.refundStatus) {
        // Sync local database with Truth from Razorpay
        await orderRef.update({
          refundStatus: latestRefund.status,
          refundAmount: latestRefund.amount ? (latestRefund.amount as number) / 100 : orderData.refundAmount,
          refundId: latestRefund.id,
        });
        logger.info(`[syncRefundHistory] Synced local refundStatus for ${orderId} from ${orderData.refundStatus} to ${latestRefund.status}`);
      }
    }

    return { 
      success: true, 
      count: refundsData.count || 0,
      refunds: refundsData.items || [] 
    };
  } catch (err: unknown) {
    const error = err as Error;
    logger.error("Failed to fetch Razorpay Refunds", error);
    throw new functions.https.HttpsError("internal", error.message || "Failed to communicate with Razorpay network.");
  }
});
