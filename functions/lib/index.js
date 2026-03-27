"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.onNewOrder = exports.cleanupAbandonedOrders = exports.onOrderStatusChange = exports.verifyPassPayment = exports.createPassOrder = exports.verifyPayment = exports.createOrder = void 0;
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-functions/v2/firestore");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const admin = __importStar(require("firebase-admin"));
const razorpay_1 = __importDefault(require("razorpay"));
const crypto = __importStar(require("crypto"));
admin.initializeApp();
const db = admin.firestore();
// Lazy-initialize Razorpay to avoid module-load crash when env vars aren't yet available
let _razorpay = null;
function getRazorpay() {
    if (!_razorpay) {
        _razorpay = new razorpay_1.default({
            key_id: process.env.RAZORPAY_KEY_ID || "",
            key_secret: process.env.RAZORPAY_KEY_SECRET || "",
        });
    }
    return _razorpay;
}
// ---------- FCM Push Notification Helper ----------
/**
 * Send a push notification to a user's registered devices.
 * Reads fcmTokens[] from the user's Firestore document and sends via FCM.
 * Automatically cleans up invalid/expired tokens.
 */
async function sendPushToUser(userId, title, body, data) {
    try {
        const userDoc = await db.collection("users").doc(userId).get();
        if (!userDoc.exists)
            return;
        const userData = userDoc.data();
        const tokens = userData.fcmTokens || [];
        if (tokens.length === 0) {
            console.log(`[FCM] No FCM tokens for user ${userId.slice(-6)}, skipping push`);
            return;
        }
        const message = {
            notification: { title, body },
            data: data || {},
            android: {
                priority: "high",
                notification: {
                    channelId: "ezyprint_orders",
                    priority: "high",
                    sound: "default",
                    defaultVibrateTimings: true,
                    notificationCount: 1,
                },
            },
            apns: {
                headers: {
                    "apns-priority": "10",
                },
                payload: {
                    aps: {
                        alert: { title, body },
                        sound: "default",
                        badge: 1,
                        "content-available": 1,
                        "mutable-content": 1,
                    },
                },
            },
        };
        // Send to all registered devices
        const invalidTokens = [];
        for (const token of tokens) {
            try {
                await admin.messaging().send({ ...message, token });
                console.log(`[FCM] Push sent to token ${token.slice(-8)} for user ${userId.slice(-6)}`);
            }
            catch (err) {
                // Token is invalid or expired — mark for cleanup
                if (err.code === "messaging/invalid-registration-token" ||
                    err.code === "messaging/registration-token-not-registered") {
                    invalidTokens.push(token);
                    console.warn(`[FCM] Invalid token ${token.slice(-8)}, will remove`);
                }
                else {
                    console.error(`[FCM] Error sending to token ${token.slice(-8)}:`, err.message);
                }
            }
        }
        // Clean up invalid tokens
        if (invalidTokens.length > 0) {
            const validTokens = tokens.filter(t => !invalidTokens.includes(t));
            await db.collection("users").doc(userId).update({ fcmTokens: validTokens });
            console.log(`[FCM] Cleaned ${invalidTokens.length} invalid token(s) for user ${userId.slice(-6)}`);
        }
    }
    catch (error) {
        console.error(`[FCM] Failed to send push to user ${userId.slice(-6)}:`, error.message);
    }
}
/**
 * Send push to the shop owner by looking up the shop's ownerUserId.
 */
async function sendPushToShop(shopId, title, body, data) {
    try {
        const shopDoc = await db.collection("shops").doc(shopId).get();
        if (!shopDoc.exists)
            return;
        const ownerUserId = shopDoc.data().ownerUserId;
        if (ownerUserId) {
            await sendPushToUser(ownerUserId, title, body, data);
        }
    }
    catch (error) {
        console.error(`[FCM] Failed to send push to shop ${shopId}:`, error.message);
    }
}
function calculateBaseFee(pageCost) {
    if (pageCost <= 0)
        return 0;
    if (pageCost <= 5)
        return 2;
    if (pageCost <= 30)
        return 3;
    if (pageCost <= 70)
        return 4;
    return 5;
}
function calculateFilePageCost(pageCount, color, copies, doubleSided, shopPricing) {
    if (pageCount <= 0 || copies <= 0)
        return 0;
    const singleSideRate = color === "COLOR" ? shopPricing.colorPerPage : shopPricing.bwPerPage;
    if (doubleSided && pageCount > 1) {
        const fullSheets = Math.floor(pageCount / 2);
        const remainderPages = pageCount % 2;
        const doubleSideSheetRate = singleSideRate * 1.5;
        const singleCopyCost = (fullSheets * doubleSideSheetRate) + (remainderPages * singleSideRate);
        return singleCopyCost * copies;
    }
    return pageCount * singleSideRate * copies;
}
function calculateOrderPrice(printOptions, shopPricing, hasStudentPass = false) {
    const { pages, copies, color, doubleSided } = printOptions;
    if (pages <= 0 || copies <= 0) {
        return { pageCost: 0, baseFee: 0, totalPrice: 0 };
    }
    const singleSideRate = color === "COLOR" ? shopPricing.colorPerPage : shopPricing.bwPerPage;
    let totalCost;
    if (doubleSided && pages > 1) {
        const fullSheets = Math.floor(pages / 2);
        const remainderPages = pages % 2;
        const doubleSideSheetRate = singleSideRate * 1.5;
        const singleCopyCost = (fullSheets * doubleSideSheetRate) + (remainderPages * singleSideRate);
        totalCost = singleCopyCost * copies;
    }
    else {
        totalCost = pages * singleSideRate * copies;
    }
    const calculatedPageCost = totalCost;
    let calculatedBaseFee = calculateBaseFee(calculatedPageCost);
    if (hasStudentPass && calculatedPageCost <= 30) {
        calculatedBaseFee = 0;
    }
    const calculatedTotalPrice = calculatedPageCost + calculatedBaseFee;
    return {
        pageCost: parseFloat(calculatedPageCost.toFixed(2)),
        baseFee: parseFloat(calculatedBaseFee.toFixed(2)),
        totalPrice: parseFloat(calculatedTotalPrice.toFixed(2)),
    };
}
/**
 * Calculate price for multi-file orders with per-file settings.
 */
function calculateMultiFilePrice(files, shopPricing, hasStudentPass = false) {
    if (files.length === 0) {
        return { pageCost: 0, baseFee: 0, totalPrice: 0 };
    }
    let totalPageCost = 0;
    for (const file of files) {
        if (file.copies <= 0 || file.pageCount <= 0)
            continue;
        totalPageCost += calculateFilePageCost(file.pageCount, file.color, file.copies, file.doubleSided, shopPricing);
    }
    let calculatedBaseFee = calculateBaseFee(totalPageCost);
    if (hasStudentPass && totalPageCost <= 30) {
        calculatedBaseFee = 0;
    }
    const calculatedTotalPrice = totalPageCost + calculatedBaseFee;
    return {
        pageCost: parseFloat(totalPageCost.toFixed(2)),
        baseFee: parseFloat(calculatedBaseFee.toFixed(2)),
        totalPrice: parseFloat(calculatedTotalPrice.toFixed(2)),
    };
}
// ---------- Cloud Functions ----------
/**
 * createOrder — Creates a Razorpay order for a print order.
 * Recalculates price server-side to prevent client-side manipulation.
 */
exports.createOrder = (0, https_1.onCall)({ region: "asia-south1", cors: true }, async (request) => {
    // Auth check
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "You must be logged in.");
    }
    const { orderId } = request.data;
    if (!orderId) {
        throw new https_1.HttpsError("invalid-argument", "orderId is required.");
    }
    // Fetch order from Firestore
    const orderDoc = await db.collection("orders").doc(orderId).get();
    if (!orderDoc.exists) {
        throw new https_1.HttpsError("not-found", "Order not found.");
    }
    const orderData = orderDoc.data();
    // Verify the order belongs to this user
    if (orderData.userId !== request.auth.uid) {
        throw new https_1.HttpsError("permission-denied", "You can only pay for your own orders.");
    }
    // Verify order is in a payable status (initial payment or retry)
    if (orderData.status !== "PENDING_PAYMENT" && orderData.status !== "PAYMENT_FAILED") {
        throw new https_1.HttpsError("failed-precondition", `Order is not awaiting payment. Current status: ${orderData.status}`);
    }
    // Fetch shop pricing from Firestore
    const shopDoc = await db.collection("shops").doc(orderData.shopId).get();
    if (!shopDoc.exists) {
        throw new https_1.HttpsError("not-found", "Shop not found.");
    }
    const shopData = shopDoc.data();
    // Fetch user data to check student pass
    const userDoc = await db
        .collection("users")
        .doc(request.auth.uid)
        .get();
    const hasStudentPass = userDoc.exists
        ? userDoc.data()?.hasStudentPass === true
        : false;
    // Recalculate price server-side
    // Use multi-file pricing if files[] array exists, else fall back to legacy
    let verifiedPrice;
    const filesArray = orderData.files;
    if (filesArray && filesArray.length > 0) {
        verifiedPrice = calculateMultiFilePrice(filesArray, shopData.customPricing, hasStudentPass);
    }
    else {
        verifiedPrice = calculateOrderPrice(orderData.printOptions, shopData.customPricing, hasStudentPass);
    }
    const amountInPaise = Math.round(verifiedPrice.totalPrice * 100);
    if (amountInPaise <= 0) {
        throw new https_1.HttpsError("failed-precondition", "Order amount must be greater than zero.");
    }
    // Create Razorpay order
    const razorpayOrder = await getRazorpay().orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt: orderId.slice(-40),
        notes: {
            orderId: orderId,
            shopId: orderData.shopId,
            userId: request.auth.uid,
            type: "print_order",
        },
    });
    // Update order with server-verified price and razorpay order ID
    await db.collection("orders").doc(orderId).update({
        priceDetails: verifiedPrice,
        razorpayOrderId: razorpayOrder.id,
    });
    return {
        razorpayOrderId: razorpayOrder.id,
        amount: amountInPaise,
        currency: "INR",
        verifiedPrice: verifiedPrice,
    };
});
/**
 * verifyPayment — Verifies Razorpay payment signature and updates order status.
 */
exports.verifyPayment = (0, https_1.onCall)({ region: "asia-south1", cors: true }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "You must be logged in.");
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId, } = request.data;
    if (!razorpay_order_id ||
        !razorpay_payment_id ||
        !razorpay_signature ||
        !orderId) {
        throw new https_1.HttpsError("invalid-argument", "Missing payment verification parameters.");
    }
    // Verify signature using HMAC SHA256
    const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
    const generatedSignature = crypto
        .createHmac("sha256", keySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest("hex");
    if (generatedSignature !== razorpay_signature) {
        // Signature mismatch - potential tampering
        await db.collection("orders").doc(orderId).update({
            status: "PAYMENT_FAILED",
            paymentAttemptedAt: new Date().toISOString(),
        });
        throw new https_1.HttpsError("failed-precondition", "Payment verification failed. Signature mismatch.");
    }
    // Signature is valid — update order
    const orderDoc = await db.collection("orders").doc(orderId).get();
    if (!orderDoc.exists) {
        throw new https_1.HttpsError("not-found", "Order not found.");
    }
    const orderData = orderDoc.data();
    if (orderData.userId !== request.auth.uid) {
        throw new https_1.HttpsError("permission-denied", "You can only verify your own orders.");
    }
    await db.collection("orders").doc(orderId).update({
        status: "PENDING_APPROVAL",
        razorpayPaymentId: razorpay_payment_id,
        paymentAttemptedAt: new Date().toISOString(),
    });
    return { success: true, message: "Payment verified successfully." };
});
/**
 * createPassOrder — Creates a Razorpay order for Student Pass purchase.
 */
exports.createPassOrder = (0, https_1.onCall)({ region: "asia-south1", cors: true }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "You must be logged in.");
    }
    // Verify user is a student
    const userDoc = await db
        .collection("users")
        .doc(request.auth.uid)
        .get();
    if (!userDoc.exists) {
        throw new https_1.HttpsError("not-found", "User profile not found.");
    }
    const userData = userDoc.data();
    if (userData.type !== "STUDENT") {
        throw new https_1.HttpsError("permission-denied", "Only students can purchase a Student Pass.");
    }
    if (userData.hasStudentPass === true) {
        throw new https_1.HttpsError("failed-precondition", "You already have an active Student Pass.");
    }
    const amountInPaise = 4900; // ₹49
    // Create Razorpay order
    const razorpayOrder = await getRazorpay().orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt: `ps_${request.auth.uid.slice(-12)}_${Date.now()}`.slice(0, 40),
        notes: {
            userId: request.auth.uid,
            type: "student_pass",
        },
    });
    return {
        razorpayOrderId: razorpayOrder.id,
        amount: amountInPaise,
        currency: "INR",
    };
});
/**
 * verifyPassPayment — Verifies Student Pass payment and activates the pass.
 */
exports.verifyPassPayment = (0, https_1.onCall)({ region: "asia-south1", cors: true }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "You must be logged in.");
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, } = request.data;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        throw new https_1.HttpsError("invalid-argument", "Missing payment verification parameters.");
    }
    // Verify signature
    const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
    const generatedSignature = crypto
        .createHmac("sha256", keySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest("hex");
    if (generatedSignature !== razorpay_signature) {
        throw new https_1.HttpsError("failed-precondition", "Payment verification failed. Signature mismatch.");
    }
    // Activate Student Pass
    await db.collection("users").doc(request.auth.uid).update({
        hasStudentPass: true,
        studentPassPaymentId: razorpay_payment_id,
        studentPassActivatedAt: new Date().toISOString(),
    });
    return { success: true, message: "Student Pass activated successfully!" };
});
/**
 * onOrderStatusChange — Firestore trigger that auto-deletes uploaded files from
 * Firebase Storage when an order is marked as COMPLETED or CANCELLED.
 * This is a production safety net — the client also attempts deletion,
 * but this ensures cleanup even if the client fails.
 */
exports.onOrderStatusChange = (0, firestore_1.onDocumentUpdated)({ document: "orders/{orderId}", region: "asia-south1" }, async (event) => {
    const beforeData = event.data?.before.data();
    const afterData = event.data?.after.data();
    if (!beforeData || !afterData)
        return;
    const oldStatus = beforeData.status;
    const newStatus = afterData.status;
    // Only trigger on actual status transitions
    if (oldStatus === newStatus)
        return;
    const orderId = event.params.orderId;
    const orderShortId = orderId.slice(-6);
    const fileName = afterData.fileName || "document";
    // --- PUSH NOTIFICATIONS for all status transitions ---
    try {
        if (newStatus === "PENDING_APPROVAL") {
            await sendPushToUser(afterData.userId, "Payment Confirmed! ✅", `Order #${orderShortId} (${fileName}) — payment verified. Your print is queued.`, { orderId, type: "order_status" });
            // Also notify the shopkeeper about the new paid order
            await sendPushToShop(afterData.shopId, "New Paid Order! 🖨️", `Order #${orderShortId} (${fileName}) — ₹${afterData.priceDetails?.totalPrice?.toFixed(2) || "?"} paid. Ready to print.`, { orderId, type: "new_order" });
        }
        else if (newStatus === "PRINTING") {
            await sendPushToUser(afterData.userId, "Printing Started 🖨️", `Order #${orderShortId} (${fileName}) is now being printed.`, { orderId, type: "order_status" });
        }
        else if (newStatus === "READY_FOR_PICKUP") {
            const pickupCode = afterData.pickupCode || "";
            await sendPushToUser(afterData.userId, "Ready for Pickup! 📦", `Order #${orderShortId} is ready! ${pickupCode ? `Pickup code: ${pickupCode}` : "Show your order ID."}`, { orderId, type: "order_status", pickupCode });
        }
        else if (newStatus === "COMPLETED") {
            await sendPushToUser(afterData.userId, "Order Complete ✅", `Order #${orderShortId} (${fileName}) has been completed. Thank you!`, { orderId, type: "order_status" });
        }
        else if (newStatus === "CANCELLED") {
            await sendPushToUser(afterData.userId, "Order Cancelled ❌", `Order #${orderShortId} (${fileName}) has been cancelled.${afterData.shopNotes ? " Reason: " + afterData.shopNotes : ""}`, { orderId, type: "order_status" });
        }
        else if (newStatus === "PAYMENT_FAILED") {
            await sendPushToUser(afterData.userId, "Payment Failed ⚠️", `Payment failed for order #${orderShortId}. Please try again.`, { orderId, type: "order_status" });
        }
    }
    catch (pushError) {
        // Push notification failures should never break the main flow
        console.error(`[onOrderStatusChange] Push notification error:`, pushError.message);
    }
    // --- AUTO-REFUND & FILE CLEANUP: Only for COMPLETED or CANCELLED ---
    if (newStatus !== "COMPLETED" && newStatus !== "CANCELLED")
        return;
    // --- AUTO-REFUND: Issue Razorpay refund when a PAID order is CANCELLED ---
    if (newStatus === "CANCELLED" && afterData.razorpayPaymentId) {
        console.log(`[onOrderStatusChange] Order #${orderId.slice(-6)} cancelled with payment ${afterData.razorpayPaymentId}. Initiating automatic refund...`);
        try {
            const refund = await getRazorpay().payments.refund(afterData.razorpayPaymentId, {
                speed: "normal", // "normal" for 5-7 day refund, "optimum" for instant if eligible
                notes: {
                    orderId: orderId,
                    reason: "Order cancelled",
                },
            });
            // Record refund details on the order document
            await db.collection("orders").doc(orderId).update({
                refundId: refund.id,
                refundStatus: refund.status, // "processed" or "pending"
                refundAmount: (refund.amount || 0) / 100, // Convert paise to rupees
                refundedAt: new Date().toISOString(),
            });
            console.log(`[onOrderStatusChange] Refund ${refund.id} initiated for order #${orderId.slice(-6)}. Status: ${refund.status}, Amount: ₹${((refund.amount || 0) / 100).toFixed(2)}`);
            // Create a notification for the student about the refund
            try {
                await db.collection("notifications").add({
                    message: `Refund of ₹${((refund.amount || 0) / 100).toFixed(2)} has been initiated for cancelled order #${orderId.slice(-6)}. It will be credited to your original payment method within 5-7 business days.`,
                    type: "info",
                    recipientUserId: afterData.userId,
                    orderId: orderId,
                    read: false,
                    timestamp: new Date().toISOString(),
                });
            }
            catch (notifError) {
                console.warn(`[onOrderStatusChange] Failed to create refund notification:`, notifError.message);
            }
        }
        catch (refundError) {
            console.error(`[onOrderStatusChange] REFUND FAILED for order #${orderId.slice(-6)}, payment ${afterData.razorpayPaymentId}:`, refundError.message);
            // Mark order as needing manual refund so admin can investigate
            await db.collection("orders").doc(orderId).update({
                refundStatus: "FAILED",
                refundError: refundError.message || "Unknown refund error",
                refundedAt: new Date().toISOString(),
            });
            // Notify admin about the failed refund
            try {
                await db.collection("notifications").add({
                    message: `⚠️ AUTO-REFUND FAILED for order #${orderId.slice(-6)} (Payment: ${afterData.razorpayPaymentId}). Manual refund required. Error: ${refundError.message}`,
                    type: "error",
                    targetUserType: "ADMIN",
                    read: false,
                    timestamp: new Date().toISOString(),
                });
            }
            catch (notifError) {
                console.warn(`[onOrderStatusChange] Failed to create admin refund-failure notification:`, notifError.message);
            }
        }
    }
    // --- FILE CLEANUP: Delete uploaded files from Storage ---
    const bucket = admin.storage().bucket();
    const filesArray = afterData.files;
    if (filesArray && filesArray.length > 0) {
        // Multi-file order: delete all files
        for (const fileEntry of filesArray) {
            if (fileEntry.fileStoragePath && !fileEntry.isFileDeleted) {
                try {
                    const storageFile = bucket.file(fileEntry.fileStoragePath);
                    const [exists] = await storageFile.exists();
                    if (exists) {
                        await storageFile.delete();
                        console.log(`[onOrderStatusChange] Deleted file: ${fileEntry.fileStoragePath} for order ${orderId}`);
                    }
                }
                catch (error) {
                    console.error(`[onOrderStatusChange] Failed to delete file ${fileEntry.fileStoragePath}:`, error.message);
                }
            }
        }
        // Mark all files as deleted
        const updatedFiles = filesArray.map(f => ({ ...f, isFileDeleted: true }));
        await db.collection("orders").doc(orderId).update({
            files: updatedFiles,
            isFileDeleted: true,
        });
    }
    else {
        // Legacy single-file order
        const fileStoragePath = afterData.fileStoragePath;
        const isFileDeleted = afterData.isFileDeleted;
        if (fileStoragePath && !isFileDeleted) {
            try {
                const storageFile = bucket.file(fileStoragePath);
                const [exists] = await storageFile.exists();
                if (exists) {
                    await storageFile.delete();
                    console.log(`[onOrderStatusChange] Deleted file: ${fileStoragePath} for order ${orderId}`);
                }
                await db.collection("orders").doc(orderId).update({ isFileDeleted: true });
            }
            catch (error) {
                console.error(`[onOrderStatusChange] Failed to delete file for order ${orderId}:`, error.message);
            }
        }
        else {
            console.log(`[onOrderStatusChange] No file to clean up for order ${orderId}`);
        }
    }
});
/**
 * cleanupAbandonedOrders — Scheduled CRON job that runs every hour.
 * Scans for orders stuck in PENDING_PAYMENT for more than 2 hours,
 * deletes their uploaded files from Firebase Storage, and marks them CANCELLED.
 * This prevents the "ghost file" storage cost attack.
 */
exports.cleanupAbandonedOrders = (0, scheduler_1.onSchedule)({
    schedule: "every 1 hours",
    region: "asia-south1",
    timeoutSeconds: 300,
}, async () => {
    const cutoffTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    console.log(`[cleanupAbandonedOrders] Running cleanup. Cutoff time: ${cutoffTime}`);
    try {
        // Query orders that are PENDING_PAYMENT and were created before the cutoff
        const abandonedOrdersSnapshot = await db
            .collection("orders")
            .where("status", "==", "PENDING_PAYMENT")
            .where("uploadedAt", "<", cutoffTime)
            .get();
        if (abandonedOrdersSnapshot.empty) {
            console.log("[cleanupAbandonedOrders] No abandoned orders found.");
            return;
        }
        console.log(`[cleanupAbandonedOrders] Found ${abandonedOrdersSnapshot.size} abandoned order(s).`);
        const bucket = admin.storage().bucket();
        let deletedCount = 0;
        let errorCount = 0;
        for (const orderDoc of abandonedOrdersSnapshot.docs) {
            const orderData = orderDoc.data();
            const orderId = orderDoc.id;
            try {
                // Delete all files from Storage (multi-file or legacy)
                const filesArr = orderData.files;
                if (filesArr && filesArr.length > 0) {
                    for (const fileEntry of filesArr) {
                        if (fileEntry.fileStoragePath && !fileEntry.isFileDeleted) {
                            const storageFile = bucket.file(fileEntry.fileStoragePath);
                            const [exists] = await storageFile.exists();
                            if (exists) {
                                await storageFile.delete();
                                console.log(`[cleanupAbandonedOrders] Deleted file: ${fileEntry.fileStoragePath}`);
                            }
                        }
                    }
                    const updatedFiles = filesArr.map(f => ({ ...f, isFileDeleted: true }));
                    await db.collection("orders").doc(orderId).update({
                        status: "CANCELLED",
                        files: updatedFiles,
                        isFileDeleted: true,
                        shopNotes: "Auto-cancelled: payment not completed within 2 hours.",
                        cancelledAt: new Date().toISOString(),
                    });
                }
                else {
                    // Legacy single-file cleanup
                    if (orderData.fileStoragePath && !orderData.isFileDeleted) {
                        const storageFile = bucket.file(orderData.fileStoragePath);
                        const [exists] = await storageFile.exists();
                        if (exists) {
                            await storageFile.delete();
                            console.log(`[cleanupAbandonedOrders] Deleted file: ${orderData.fileStoragePath}`);
                        }
                    }
                    await db.collection("orders").doc(orderId).update({
                        status: "CANCELLED",
                        isFileDeleted: true,
                        shopNotes: "Auto-cancelled: payment not completed within 2 hours.",
                        cancelledAt: new Date().toISOString(),
                    });
                }
                deletedCount++;
                console.log(`[cleanupAbandonedOrders] Cancelled abandoned order #${orderId.slice(-6)}`);
            }
            catch (orderError) {
                errorCount++;
                console.error(`[cleanupAbandonedOrders] Error processing order ${orderId}:`, orderError.message);
            }
        }
        console.log(`[cleanupAbandonedOrders] Cleanup complete. Cancelled: ${deletedCount}, Errors: ${errorCount}`);
    }
    catch (error) {
        console.error("[cleanupAbandonedOrders] Fatal error during cleanup:", error.message);
    }
});
/**
 * onNewOrder — Push notification to shopkeeper when a new order is created.
 * Triggers when an order document is first written to Firestore.
 */
exports.onNewOrder = (0, firestore_1.onDocumentCreated)({ document: "orders/{orderId}", region: "asia-south1" }, async (event) => {
    const orderData = event.data?.data();
    if (!orderData)
        return;
    const orderId = event.params.orderId;
    const orderShortId = orderId.slice(-6);
    const fileName = orderData.fileName || "document";
    const fileCount = orderData.files?.length || 1;
    const totalPrice = orderData.priceDetails?.totalPrice?.toFixed(2) || "?";
    const fileLabel = fileCount === 1 ? fileName : `${fileCount} files`;
    // Notify the shopkeeper about the new order
    try {
        await sendPushToShop(orderData.shopId, "New Order Received! 📄", `Order #${orderShortId} (${fileLabel}) — ₹${totalPrice}. Awaiting payment.`, { orderId, type: "new_order" });
    }
    catch (error) {
        console.error(`[onNewOrder] Push notification error:`, error.message);
    }
});
//# sourceMappingURL=index.js.map