/* eslint-disable @typescript-eslint/no-explicit-any */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentUpdated, onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import * as admin from "firebase-admin";
import Razorpay from "razorpay";
import * as crypto from "crypto";
import * as nodemailer from "nodemailer";

import { verifyAdminOTP } from "./backendResilience";
import { enforceRateLimit } from "./rateLimit";

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// Lazy-initialize Razorpay to avoid module-load crash when env vars aren't yet available
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

// ---------- FCM Push Notification Helper ----------

/**
 * Send a push notification to a user's registered devices.
 * Reads fcmTokens[] from the user's Firestore document and sends via FCM.
 * Automatically cleans up invalid/expired tokens.
 */
async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  try {
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return;

    const userData = userDoc.data()!;
    const tokens: string[] = userData.fcmTokens || [];

    if (tokens.length === 0) {
      logger.info(`[FCM] No FCM tokens for user ${userId.slice(-6)}, skipping push`);
      return;
    }

    const message = {
      notification: { title, body },
      data: data || {},
      android: {
        priority: "high" as const,
        notification: {
          channelId: "ezyprint_orders",
          priority: "high" as const,
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

    // Send to all registered devices in parallel so large token lists don't serialize latency.
    const sendResults = await Promise.allSettled(
      tokens.map(async (token) => {
        await admin.messaging().send({ ...message, token });
        return token;
      })
    );

    const invalidTokens: string[] = [];
    sendResults.forEach((result, index) => {
      const token = tokens[index];
      if (result.status === "fulfilled") {
        logger.info(`[FCM] Push sent to token ${token.slice(-8)} for user ${userId.slice(-6)}`);
        return;
      }

      const err = result.reason as { code?: string; message?: string };
      if (
        err?.code === "messaging/invalid-registration-token" ||
        err?.code === "messaging/registration-token-not-registered"
      ) {
        invalidTokens.push(token);
        logger.warn(`[FCM] Invalid token ${token.slice(-8)}, will remove`);
      } else {
        logger.error(`[FCM] Error sending to token ${token.slice(-8)}:`, err?.message || String(result.reason));
      }
    });

    // Clean up invalid tokens
    if (invalidTokens.length > 0) {
      const validTokens = tokens.filter(t => !invalidTokens.includes(t));
      await db.collection("users").doc(userId).update({ fcmTokens: validTokens });
      logger.info(`[FCM] Cleaned ${invalidTokens.length} invalid token(s) for user ${userId.slice(-6)}`);
    }
  } catch (error: any) {
    logger.error(`[FCM] Failed to send push to user ${userId.slice(-6)}:`, error.message);
  }
}

/**
 * Send push to the shop owner by looking up the shop's ownerUserId.
 */
async function sendPushToShop(
  shopId: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  try {
    const shopDoc = await db.collection("shops").doc(shopId).get();
    if (!shopDoc.exists) return;
    const ownerUserId = shopDoc.data()!.ownerUserId;
    if (ownerUserId) {
      await sendPushToUser(ownerUserId, title, body, data);
    }
  } catch (error: any) {
    logger.error(`[FCM] Failed to send push to shop ${shopId}:`, error.message);
  }
}

async function getPayoutOrderIdsForRequest(
  transaction: admin.firestore.Transaction,
  shopId: string,
  amount: number
): Promise<string[]> {
  const settledEntriesSnap = await transaction.get(
    db.collection("shopLedger")
      .where("shopId", "==", shopId)
      .where("type", "==", "ORDER_EARNING")
      .where("status", "==", "SETTLED")
  );

  const payoutsSnap = await transaction.get(
    db.collection("payouts").where("shopId", "==", shopId)
  );

  const reservedOrderIds = new Set<string>();
  payoutsSnap.docs.forEach((docSnap) => {
    const payoutData = docSnap.data();
    if (["REJECTED", "CANCELLED"].includes(payoutData.status)) return;
    const payoutOrderIds = Array.isArray(payoutData.payoutOrderIds) ? payoutData.payoutOrderIds : [];
    payoutOrderIds.forEach((orderId: string) => reservedOrderIds.add(orderId));
  });

  const candidateEntries = settledEntriesSnap.docs
    .map((docSnap) => docSnap.data())
    .filter((entry) => entry.amount > 0 && entry.orderId && !reservedOrderIds.has(entry.orderId))
    .sort((a, b) => {
      const aTime = new Date(a.settledAt || a.createdAt || 0).getTime();
      const bTime = new Date(b.settledAt || b.createdAt || 0).getTime();
      return aTime - bTime;
    });

  const payoutOrderIds: string[] = [];
  let accumulatedAmount = 0;

  for (const entry of candidateEntries) {
    payoutOrderIds.push(entry.orderId);
    accumulatedAmount += entry.amount || 0;
    if (accumulatedAmount >= amount) break;
  }

  return payoutOrderIds;
}

async function syncShopAggregate(shopId: string): Promise<void> {
  if (!shopId) return;

  const aggregateRef = db.collection("shopAggregates").doc(shopId);
  const [shopDoc, ordersSnap, payoutsSnap] = await Promise.all([
    db.collection("shops").doc(shopId).get(),
    db.collection("orders").where("shopId", "==", shopId).get(),
    db.collection("payouts").where("shopId", "==", shopId).get(),
  ]);

  if (!shopDoc.exists) {
    try {
      await aggregateRef.delete();
    } catch {
      // Ignore delete miss / permission issues inside cleanup races.
    }
    return;
  }

  const orders = ordersSnap.docs.map((docSnap) => docSnap.data());
  const payouts = payoutsSnap.docs.map((docSnap) => docSnap.data());
  const activeOrderStatuses = new Set(["PENDING_APPROVAL", "PRINTING", "READY_FOR_PICKUP"]);

  const completedOrders = orders.filter((order) => order.status === "COMPLETED");
  const paidOutPayouts = payouts.filter((payout) => payout.status === "PAID" || payout.status === "CONFIRMED");
  const pendingPayouts = payouts.filter((payout) => payout.status === "PENDING");

  await aggregateRef.set({
    shopId,
    totalOrders: orders.length,
    activeOrders: orders.filter((order) => activeOrderStatuses.has(order.status)).length,
    completedOrders: completedOrders.length,
    totalRevenue: completedOrders.reduce((sum, order) => sum + (order.priceDetails?.pageCost || 0), 0),
    totalBaseFees: completedOrders.reduce((sum, order) => sum + (order.priceDetails?.baseFee || 0), 0),
    totalPaidOut: paidOutPayouts.reduce((sum, payout) => sum + (payout.amount || 0), 0),
    pendingPayouts: pendingPayouts.reduce((sum, payout) => sum + (payout.amount || 0), 0),
    pendingPayoutCount: pendingPayouts.length,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

// ---------- Pricing Logic (mirrored from frontend) ----------

interface ShopPricing {
  bwPerPage: number;
  colorPerPage: number;
}

interface PrintOptions {
  pages: number;
  copies: number;
  color: string;
  doubleSided: boolean;
}

interface OrderFileData {
  fileName: string;
  fileType: string;
  fileStoragePath?: string;
  fileSizeBytes?: number;
  isFileDeleted?: boolean;
  pageCount: number;
  color: string;
  copies: number;
  doubleSided: boolean;
}

const SUPPORTED_ORDER_FILE_TYPES = new Set([
  "PDF",
  "PPT",
  "PPTX",
  "JPG",
  "JPEG",
  "PNG",
  "WEBP",
]);

function calculateBaseFee(pageCost: number): number {
  if (pageCost <= 0) return 0;
  if (pageCost <= 5) return 2;
  if (pageCost <= 30) return 3;
  if (pageCost <= 70) return 4;
  return 5;
}

function calculateFilePageCost(
  pageCount: number,
  color: string,
  copies: number,
  doubleSided: boolean,
  shopPricing: ShopPricing
): number {
  if (pageCount <= 0 || copies <= 0) return 0;
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

function calculateOrderPrice(
  printOptions: PrintOptions,
  shopPricing: ShopPricing,
  hasStudentPass: boolean = false
): { pageCost: number; baseFee: number; totalPrice: number } {
  const { pages, copies, color, doubleSided } = printOptions;
  if (pages <= 0 || copies <= 0) {
    return { pageCost: 0, baseFee: 0, totalPrice: 0 };
  }

  const singleSideRate =
    color === "COLOR" ? shopPricing.colorPerPage : shopPricing.bwPerPage;

  let totalCost: number;
  if (doubleSided && pages > 1) {
    const fullSheets = Math.floor(pages / 2);
    const remainderPages = pages % 2;
    const doubleSideSheetRate = singleSideRate * 1.5;
    const singleCopyCost = (fullSheets * doubleSideSheetRate) + (remainderPages * singleSideRate);
    totalCost = singleCopyCost * copies;
  } else {
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
function calculateMultiFilePrice(
  files: OrderFileData[],
  shopPricing: ShopPricing,
  hasStudentPass: boolean = false
): { pageCost: number; baseFee: number; totalPrice: number } {
  if (files.length === 0) {
    return { pageCost: 0, baseFee: 0, totalPrice: 0 };
  }

  let totalPageCost = 0;
  for (const file of files) {
    if (file.copies <= 0 || file.pageCount <= 0) continue;
    totalPageCost += calculateFilePageCost(
      file.pageCount,
      file.color,
      file.copies,
      file.doubleSided,
      shopPricing
    );
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

function isStudentPassActive(userData: admin.firestore.DocumentData | undefined): boolean {
  if (!userData?.hasStudentPass || !userData.studentPassActivatedAt) {
    return false;
  }

  const activatedAt = new Date(userData.studentPassActivatedAt).getTime();
  const expiryDate = activatedAt + 30 * 24 * 60 * 60 * 1000;
  return Date.now() < expiryDate;
}

function validateOrderDraftFiles(rawFiles: unknown): OrderFileData[] {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > 10) {
    throw new HttpsError("invalid-argument", "Orders must include between 1 and 10 files.");
  }

  return rawFiles.map((rawFile, index) => {
    if (!rawFile || typeof rawFile !== "object") {
      throw new HttpsError("invalid-argument", `File #${index + 1} is invalid.`);
    }

    const file = rawFile as Record<string, unknown>;
    const fileName = typeof file.fileName === "string" ? file.fileName.trim() : "";
    const fileType = typeof file.fileType === "string" ? file.fileType.trim().toUpperCase() : "";
    const pageCount = Number(file.pageCount);
    const copies = Number(file.copies);
    const color = typeof file.color === "string" ? file.color : "";
    const doubleSided = typeof file.doubleSided === "boolean" ? file.doubleSided : false;
    const fileSizeBytes = Number(file.fileSizeBytes);

    if (!fileName) {
      throw new HttpsError("invalid-argument", `File #${index + 1} is missing a name.`);
    }
    if (!SUPPORTED_ORDER_FILE_TYPES.has(fileType)) {
      throw new HttpsError("invalid-argument", `File "${fileName}" is not a supported format.`);
    }
    if (!Number.isFinite(pageCount) || pageCount <= 0 || pageCount > 300) {
      throw new HttpsError("invalid-argument", `File "${fileName}" must have between 1 and 300 pages.`);
    }
    if (!Number.isFinite(copies) || copies <= 0 || copies > 500) {
      throw new HttpsError("invalid-argument", `File "${fileName}" must have between 1 and 500 copies.`);
    }
    if (color !== "BLACK_WHITE" && color !== "COLOR") {
      throw new HttpsError("invalid-argument", `File "${fileName}" has an invalid color mode.`);
    }
    if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0 || fileSizeBytes > 50 * 1024 * 1024) {
      throw new HttpsError("invalid-argument", `File "${fileName}" exceeds the allowed upload size.`);
    }

    return {
      fileName,
      fileType,
      fileSizeBytes,
      pageCount,
      color,
      copies,
      doubleSided,
      isFileDeleted: false,
    };
  });
}

function validateTicketAttachmentPaths(ticketId: string, rawAttachmentPaths: unknown): string[] {
  if (!Array.isArray(rawAttachmentPaths) || rawAttachmentPaths.length === 0 || rawAttachmentPaths.length > 3) {
    throw new HttpsError("invalid-argument", "Tickets may have between 1 and 3 attachment paths.");
  }

  return rawAttachmentPaths.map((rawPath, index) => {
    if (typeof rawPath !== "string") {
      throw new HttpsError("invalid-argument", `Attachment #${index + 1} is invalid.`);
    }
    const normalizedPath = rawPath.trim();
    if (!normalizedPath.startsWith(`tickets/${ticketId}/`) || normalizedPath.includes("..")) {
      throw new HttpsError("invalid-argument", `Attachment path "${normalizedPath}" is invalid.`);
    }
    return normalizedPath;
  });
}

// ---------- Cloud Functions ----------

/**
 * initializeOrderDraft — server-owned order draft creation before file uploads.
 * Prevents clients from forging arbitrary order docs while still allowing Storage rules
 * to authorize uploads under an existing order document.
 */
export const initializeOrderDraft = onCall(
  { region: "asia-south1", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in.");
    }
    const authUid = request.auth.uid;

    const shopId = typeof request.data?.shopId === "string" ? request.data.shopId.trim() : "";
    const specialInstructions = typeof request.data?.specialInstructions === "string"
      ? request.data.specialInstructions.trim()
      : "";
    const files = validateOrderDraftFiles(request.data?.files);

    if (!shopId) {
      throw new HttpsError("invalid-argument", "shopId is required.");
    }
    if (specialInstructions.length > 500) {
      throw new HttpsError("invalid-argument", "Special instructions are too long.");
    }

    const [shopDoc, userDoc] = await Promise.all([
      db.collection("shops").doc(shopId).get(),
      db.collection("users").doc(request.auth.uid).get(),
    ]);

    if (!shopDoc.exists) {
      throw new HttpsError("not-found", "Shop not found.");
    }
    const shopData = shopDoc.data()!;
    if (!shopData.isApproved) {
      throw new HttpsError("failed-precondition", "This shop is not approved to accept orders.");
    }
    if (shopData.isArchived) {
      throw new HttpsError("failed-precondition", "This shop is archived and cannot receive new orders.");
    }
    if (!shopData.isOpen) {
      throw new HttpsError("failed-precondition", "This shop is currently closed.");
    }
    if (!userDoc.exists) {
      throw new HttpsError("not-found", "User profile not found.");
    }

    const orderRef = db.collection("orders").doc();
    const orderId = orderRef.id;
    const uploadedAt = new Date().toISOString();
    const hasStudentPass = isStudentPassActive(userDoc.data());
    const pricedFiles = files.map((file) => ({
      ...file,
      fileStoragePath: `orders/${authUid}/${orderId}/${file.fileName}`,
    }));
    const verifiedPrice = calculateMultiFilePrice(pricedFiles, shopData.customPricing as ShopPricing, hasStudentPass);

    if (verifiedPrice.totalPrice <= 0) {
      throw new HttpsError("failed-precondition", "Order amount must be greater than zero.");
    }

    const totalPages = pricedFiles.reduce((sum, file) => sum + file.pageCount, 0);
    const maxCopies = Math.max(...pricedFiles.map((file) => file.copies), 1);
    const primaryColor = pricedFiles[0].color;
    const anyDoubleSided = pricedFiles.some((file) => file.doubleSided);
    const userData = userDoc.data() || {};

    await orderRef.set({
      id: orderId,
      userId: authUid,
      shopId,
      fileName: pricedFiles[0].fileName,
      fileType: pricedFiles[0].fileType,
      fileStoragePath: pricedFiles[0].fileStoragePath,
      fileSizeBytes: pricedFiles[0].fileSizeBytes,
      isFileDeleted: false,
      files: pricedFiles,
      uploadedAt,
      status: "PENDING_PAYMENT",
      priceDetails: verifiedPrice,
      printOptions: {
        copies: maxCopies,
        color: primaryColor,
        pages: totalPages,
        doubleSided: anyDoubleSided,
      },
      isPremiumOrder: hasStudentPass,
      userName: userData.name || request.auth.token.name || "Student",
      ...(specialInstructions ? { specialInstructions } : {}),
    });

    return {
      success: true,
      orderId,
      verifiedPrice,
    };
  }
);

/**
 * createOrder — Creates a Razorpay order for a print order.
 * Recalculates price server-side to prevent client-side manipulation.
 */
export const createOrder = onCall(
  { region: "asia-south1", cors: true },
  async (request) => {
    // Auth check
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    const { orderId } = request.data;
    if (!orderId) {
      throw new HttpsError("invalid-argument", "orderId is required.");
    }

    const authUid = request.auth.uid;
    const result = await db.runTransaction(async (transaction) => {
      // Fetch order from Firestore within transaction
      const orderDoc = await transaction.get(db.collection("orders").doc(orderId));
      if (!orderDoc.exists) {
        throw new HttpsError("not-found", "Order not found.");
      }

      const orderData = orderDoc.data()!;

      // Verify the order belongs to this user
      if (orderData.userId !== authUid) {
        throw new HttpsError("permission-denied", "You can only pay for your own orders.");
      }

      // Verify order is in a payable status (initial payment or retry)
      if (orderData.status !== "PENDING_PAYMENT" && orderData.status !== "PAYMENT_FAILED") {
        throw new HttpsError("failed-precondition", `Order is not awaiting payment. Current status: ${orderData.status}`);
      }

      // Fetch shop pricing from Firestore within transaction
      const shopDoc = await transaction.get(db.collection("shops").doc(orderData.shopId));
      if (!shopDoc.exists) {
        throw new HttpsError("not-found", "Shop not found.");
      }

      const shopData = shopDoc.data()!;

      // Enforce operational assertions before creating a payable execution context
      if (!shopData.isApproved) {
        throw new HttpsError("failed-precondition", "This shop is not approved to accept orders.");
      }
      if (shopData.isArchived) {
        throw new HttpsError("failed-precondition", "This shop is archived and cannot receive new orders.");
      }
      if (!shopData.isOpen) {
        throw new HttpsError("failed-precondition", "This shop is currently closed. Orders cannot be created.");
      }

      // Fetch user data to check student pass within transaction
      const userDoc = await transaction.get(db.collection("users").doc(authUid));
      let hasStudentPass = false;
      if (userDoc.exists) {
        const userData = userDoc.data()!;
        if (userData.hasStudentPass === true && userData.studentPassActivatedAt) {
          const activatedAt = new Date(userData.studentPassActivatedAt).getTime();
          const expiryDate = activatedAt + 30 * 24 * 60 * 60 * 1000; // 30 days
          hasStudentPass = Date.now() < expiryDate;
          // Auto-expire in DB if past 30 days
          if (!hasStudentPass) {
            transaction.update(userDoc.ref, { hasStudentPass: false });
          }
        }
      }

      // Recalculate price server-side
      let verifiedPrice: { pageCost: number; baseFee: number; totalPrice: number };
      const filesArray = orderData.files as OrderFileData[] | undefined;

      // SERVER-SIDE HEURISTICS: Prevent Page Count Form Forgery and Abuse (Bug 2)
      if (filesArray && filesArray.length > 0) {
        for (const file of filesArray) {
          // Enforce File Extension Ban directly on backend
          const ext = (file.fileType || "").toUpperCase();
          if (ext === "DOC" || ext === "DOCX") {
            throw new HttpsError("invalid-argument", `File "${file.fileName}" is a Word document, which is not supported. Please convert it to PDF.`);
          }

          // Basic limits
          if (file.pageCount <= 0) {
            throw new HttpsError("invalid-argument", `File "${file.fileName}" must have at least 1 page.`);
          }
          if (file.copies <= 0 || file.copies > 500) {
            throw new HttpsError("invalid-argument", `File "${file.fileName}" must have between 1 and 500 copies.`);
          }
          if (file.pageCount > 300) {
            throw new HttpsError("out-of-range", `File "${file.fileName}" exceeds the 300 page limit.`);
          }

          // Size-to-Page Heuristics
          if (file.fileSizeBytes !== undefined) {
            if (file.fileSizeBytes < 51200 && file.pageCount > 50) {
              logger.error(`[createOrder] FRAUD ALERT: ${file.fileName} is ${(file.fileSizeBytes / 1024).toFixed(1)}KB but claims ${file.pageCount} pages.`);
              throw new HttpsError("invalid-argument", `File "${file.fileName}" claims too many pages (${file.pageCount}) for its physical size.`);
            }

            if (file.pageCount > 5) {
              const estimatedMinBytesPerPage = 350;
              const maxPossiblePages = Math.floor(file.fileSizeBytes / estimatedMinBytesPerPage);
              if (file.pageCount > maxPossiblePages) {
                logger.warn(`[createOrder] Forgery caught: ${file.fileName} is ${file.fileSizeBytes}B but claims ${file.pageCount} pages.`);
                throw new HttpsError("invalid-argument", `File "${file.fileName}" claims too many pages (${file.pageCount}) for its physical size.`);
              }
            }
          }
        }

        verifiedPrice = calculateMultiFilePrice(filesArray, shopData.customPricing as ShopPricing, hasStudentPass);
      } else {
        const printOpts = orderData.printOptions as PrintOptions;
        if (printOpts.pages > 300) {
          throw new HttpsError("out-of-range", "Total pages exceed the 300 limit.");
        }
        verifiedPrice = calculateOrderPrice(printOpts, shopData.customPricing as ShopPricing, hasStudentPass);
      }

      const amountInPaise = Math.round(verifiedPrice.totalPrice * 100);

      if (amountInPaise <= 0) {
        throw new HttpsError("failed-precondition", "Order amount must be greater than zero.");
      }

      // Write the locked price immediately inside the transaction to tie it to the exact shop state read
      transaction.update(orderDoc.ref, { priceDetails: verifiedPrice });

      return { amountInPaise, verifiedPrice, orderData };
    });

    // Run Razorpay creation entirely outside the atomic lock to prevent multi-call triggers on retries
    const razorpayOrder = await getRazorpay().orders.create({
      amount: result.amountInPaise,
      currency: "INR",
      receipt: orderId.slice(-40),
      notes: {
        orderId: orderId,
        shopId: result.orderData.shopId,
        userId: authUid,
        type: "print_order",
      },
    });

    // Update with final receipt details
    await db.collection("orders").doc(orderId).update({
      razorpayOrderId: razorpayOrder.id,
    });

    return {
      razorpayOrderId: razorpayOrder.id,
      amount: result.amountInPaise,
      currency: "INR",
      verifiedPrice: result.verifiedPrice,
    };
  }
);

/**
 * verifyPayment — Verifies Razorpay payment signature and updates order status.
 * If signature verification fails, falls back to checking payment status directly
 * via Razorpay API (handles key mismatch scenarios where money was taken but
 * signature doesn't match due to key rotation).
 */
export const verifyPayment = onCall(
  { region: "asia-south1", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      orderId,
    } = request.data;

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !orderId
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Missing payment verification parameters."
      );
    }

    // Verify the order belongs to this user
    const orderDoc = await db.collection("orders").doc(orderId).get();
    if (!orderDoc.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }
    const orderData = orderDoc.data()!;
    if (orderData.userId !== request.auth.uid) {
      throw new HttpsError("permission-denied", "You can only verify your own orders.");
    }

    const expectedAmountPaise = Math.round((orderData.priceDetails?.totalPrice || 0) * 100);

    // Verify signature using HMAC SHA256
    const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
    const generatedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      logger.warn(`[verifyPayment] Signature mismatch for order ${orderId}. Falling back to Razorpay API check...`);

      // SAFETY NET: Check the payment status directly via Razorpay API.
      // This handles cases where the key was rotated or there's a mismatch.
      try {
        const payment = await getRazorpay().payments.fetch(razorpay_payment_id);
        if (payment.status === "captured" || payment.status === "authorized") {
          // Recovery path: if createOrder failed to persist razorpayOrderId, trust the
          // submitted/order-provider IDs only when the provider confirms the same order+amount.
          const resolvedOrderId = orderData.razorpayOrderId || razorpay_order_id;
          if (payment.order_id !== resolvedOrderId || payment.amount !== expectedAmountPaise) {
            throw new HttpsError("permission-denied", "Payment verification failed. Razorpay Order ID or amount mismatch on API fallback.");
          }
          logger.info(`[verifyPayment] Razorpay API confirms payment ${razorpay_payment_id} is ${payment.status}. Recovering order.`);
          const recoveryUpdate: Record<string, unknown> = {
            status: "PENDING_APPROVAL",
            razorpayPaymentId: razorpay_payment_id,
            paymentAttemptedAt: new Date().toISOString(),
            paymentVerifiedVia: "api_fallback",
          };
          if (!orderData.razorpayOrderId) {
            recoveryUpdate.razorpayOrderId = payment.order_id;
          }
          await db.collection("orders").doc(orderId).update(recoveryUpdate);
          return { success: true, message: "Payment verified via Razorpay API." };
        } else {
          logger.info(`[verifyPayment] Razorpay API says payment ${razorpay_payment_id} status is: ${payment.status}`);
        }
      } catch (apiError: any) {
        logger.error(`[verifyPayment] Razorpay API fallback failed:`, apiError.message);
      }

      // If API check also failed, mark as failed
      await db.collection("orders").doc(orderId).update({
        status: "PAYMENT_FAILED",
        razorpayPaymentId: razorpay_payment_id,
        paymentAttemptedAt: new Date().toISOString(),
      });

      throw new HttpsError(
        "failed-precondition",
        "Payment verification failed. Signature mismatch."
      );
    }

    // Bug 10: Enforce strict Razorpay Order ID match to prevent replay attacks
    if (orderData.razorpayOrderId && orderData.razorpayOrderId !== razorpay_order_id) {
      throw new HttpsError(
        "permission-denied",
        "Payment verification failed. Razorpay Order ID mismatch."
      );
    }

    // Signature is valid — update order
    const verifiedUpdate: Record<string, unknown> = {
      status: "PENDING_APPROVAL",
      razorpayPaymentId: razorpay_payment_id,
      paymentAttemptedAt: new Date().toISOString(),
      paymentVerifiedVia: "signature",
    };
    if (!orderData.razorpayOrderId) {
      verifiedUpdate.razorpayOrderId = razorpay_order_id;
    }
    await db.collection("orders").doc(orderId).update(verifiedUpdate);

    return { success: true, message: "Payment verified successfully." };
  }
);

/**
 * checkPaymentStatus — Checks if a payment was actually captured by querying
 * the Razorpay API directly. Used as a recovery mechanism when:
 * 1. User clicks "Retry Payment" — check if the previous payment actually went through
 * 2. User clicks "Cancel Order" — check if payment was captured (needs refund)
 *
 * If the payment was captured, it automatically updates the order to PENDING_APPROVAL.
 */
export const checkPaymentStatus = onCall(
  { region: "asia-south1", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    const { orderId } = request.data;
    if (!orderId) {
      throw new HttpsError("invalid-argument", "orderId is required.");
    }

    const orderDoc = await db.collection("orders").doc(orderId).get();
    if (!orderDoc.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }

    const orderData = orderDoc.data()!;
    if (orderData.userId !== request.auth.uid) {
      throw new HttpsError("permission-denied", "You can only check your own orders.");
    }

    // Check if there's a Razorpay order ID to look up
    const razorpayOrderId = orderData.razorpayOrderId;
    if (!razorpayOrderId) {
      return { paid: false, message: "No payment was initiated for this order." };
    }

    try {
      // Fetch the Razorpay order to get its payments
      const rzpOrder = await getRazorpay().orders.fetch(razorpayOrderId);
      const payments = await getRazorpay().orders.fetchPayments(razorpayOrderId);

      // Find a captured/authorized payment
      const successfulPayment = (payments as any).items?.find(
        (p: any) => p.status === "captured" || p.status === "authorized"
      );

      if (successfulPayment) {
        logger.info(`[checkPaymentStatus] Order ${orderId} has a captured payment: ${successfulPayment.id}`);

        // If order is still in PENDING_PAYMENT or PAYMENT_FAILED, recover it
        if (orderData.status === "PENDING_PAYMENT" || orderData.status === "PAYMENT_FAILED") {
          await db.collection("orders").doc(orderId).update({
            status: "PENDING_APPROVAL",
            razorpayPaymentId: successfulPayment.id,
            paymentAttemptedAt: new Date().toISOString(),
            paymentVerifiedVia: "manual_check",
          });
          return {
            paid: true,
            recovered: true,
            message: "Payment was already captured! Order has been updated.",
          };
        }

        return {
          paid: true,
          recovered: false,
          message: "Payment is confirmed.",
          paymentId: successfulPayment.id,
        };
      }

      return {
        paid: false,
        message: `No captured payment found. Razorpay order status: ${rzpOrder.status}`,
      };
    } catch (error: any) {
      logger.error(`[checkPaymentStatus] Error checking payment:`, error.message);
      throw new HttpsError("internal", `Failed to check payment status: ${error.message}`);
    }
  }
);

/**
 * Mailer Transporter (Lazy Loaded for cold start performance)
 */
let mailTransporter: nodemailer.Transporter | null = null;
const getMailTransporter = () => {
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER || "",
        pass: process.env.GMAIL_APP_PASSWORD || "",
      },
    });
  }
  return mailTransporter;
};

/**
 * requestRefundOTP — Admin-only function to request a 6-digit verification code.
 * Stores the OTP temporarily in Firestore and emails it securely.
 */
export const requestRefundOTP = onCall(
  { region: "asia-south1", cors: true, secrets: ["GMAIL_USER", "GMAIL_APP_PASSWORD"] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be logged in.");

    await enforceRateLimit({
      key: `refund_otp:${request.auth.uid}`,
      maxRequests: 3,
      windowMs: 15 * 60 * 1000,
      actionLabel: "refund OTP",
    });

    const callerDoc = await db.collection("users").doc(request.auth.uid).get();
    if (!callerDoc.exists || callerDoc.data()?.type !== "ADMIN") {
      throw new HttpsError("permission-denied", "Only admins can request refund OTPs.");
    }

    const adminEmail = request.auth.token.email || callerDoc.data()?.email;
    if (!adminEmail) {
      throw new HttpsError("failed-precondition", "Admin account lacks a verified email address.");
    }

    const { orderId } = request.data;
    if (!orderId) throw new HttpsError("invalid-argument", "orderId is required.");

    // Check if account is locked
    const otpDoc = await db.collection("refundOtps").doc(request.auth.uid).get();
    if (otpDoc.exists && otpDoc.data()?.lockUntil && Date.now() < otpDoc.data()?.lockUntil) {
      const lockRemainingSeconds = Math.ceil((otpDoc.data()!.lockUntil - Date.now()) / 1000);
      throw new HttpsError("resource-exhausted", `Too many failed attempts. Try again in ${lockRemainingSeconds}s.`);
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    await db.collection("refundOtps").doc(request.auth.uid).set({
      otp,
      orderId,
      expiresAt,
      failedAttempts: 0,
    });

    try {
      const emailHtml = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #18181B; border: 1px solid #E4E4E7; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
        <div style="background-color: #EF4444; padding: 24px; text-align: center;">
          <h1 style="color: #FFFFFF; margin: 0; font-size: 24px; font-weight: bold; letter-spacing: -0.5px;">EzyPrint Security</h1>
        </div>
        <div style="padding: 32px 24px;">
          <p style="margin-top: 0; font-size: 16px; line-height: 1.5;">You requested to issue a refund for Order <strong>#${orderId.slice(-6)}</strong>.</p>
          <p style="font-size: 16px; line-height: 1.5; margin-bottom: 24px;">Your verification code is:</p>
          <div style="background-color: #F4F4F5; padding: 16px; border-radius: 8px; text-align: center; margin-bottom: 32px;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #18181B;">${otp}</span>
          </div>
          <p style="font-size: 14px; color: #71717A; margin-bottom: 8px;">⚠️ This code will expire in 5 minutes.</p>
          <p style="font-size: 14px; color: #71717A; margin: 0;">If you did not request this code, please ignore this email and secure your admin account immediately.</p>
        </div>
        <div style="background-color: #FAFAFA; border-top: 1px solid #E4E4E7; padding: 16px; text-align: center;">
          <p style="font-size: 12px; color: #A1A1AA; margin: 0;">© ${new Date().getFullYear()} EzyPrint. All rights reserved.</p>
        </div>
      </div>
      `;

      await getMailTransporter().sendMail({
        from: `"EzyPrint Security" <${process.env.GMAIL_USER}>`,
        to: adminEmail,
        subject: `EzyPrint Refund Verification Code`,
        html: emailHtml,
      });
      return { success: true, message: `OTP sent successfully to ${adminEmail}` };
    } catch (error: any) {
      logger.error("[requestRefundOTP] Failed to send email:", error);
      throw new HttpsError("internal", "Failed to send OTP email. Verify SMTP settings.");
    }
  }
);

/**
 * initiateRefund — Admin-only function to manually issue a Razorpay refund.
 * Used when admin finds a discrepancy reported via support ticket and wants
 * to refund a student without requiring full order cancellation.
 *
 * Validates: caller is admin, order was paid, hasn't been refunded already.
 * Issues full refund via Razorpay API and records result on the order document.
 */
export const initiateRefund = onCall(
  { region: "asia-south1", cors: true },
  async (request) => {
    // Auth check
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    // Verify caller is admin
    const callerDoc = await db.collection("users").doc(request.auth.uid).get();
    if (!callerDoc.exists || callerDoc.data()?.type !== "ADMIN") {
      throw new HttpsError("permission-denied", "Only admins can issue refunds.");
    }

    const { orderId, reason, otp } = request.data;
    if (!orderId || !otp) {
      throw new HttpsError("invalid-argument", "orderId and otp are required.");
    }

    // OTP Verification Block
    const otpDoc = await db.collection("refundOtps").doc(request.auth.uid).get();
    if (!otpDoc.exists) {
      throw new HttpsError("failed-precondition", "No OTP found. Please request a new one.");
    }
    const otpData = otpDoc.data()!;

    if (otpData.lockUntil && Date.now() < otpData.lockUntil) {
      const lockRemainingSeconds = Math.ceil((otpData.lockUntil - Date.now()) / 1000);
      throw new HttpsError("resource-exhausted", `Too many failed attempts. Try again in ${lockRemainingSeconds}s.`);
    }

    if (Date.now() > otpData.expiresAt) {
      await db.collection("refundOtps").doc(request.auth.uid).delete();
      throw new HttpsError("failed-precondition", "OTP has expired. Please request a new one.");
    }

    if (otpData.otp !== otp || otpData.orderId !== orderId) {
      const newAttempts = (otpData.failedAttempts || 0) + 1;
      if (newAttempts >= 3) {
        await db.collection("refundOtps").doc(request.auth.uid).update({
          failedAttempts: newAttempts,
          lockUntil: Date.now() + 15 * 60 * 1000,
          otp: "LOCKED",
        });
        throw new HttpsError("resource-exhausted", "Too many failed attempts. Try again in 900s.");
      } else {
        await db.collection("refundOtps").doc(request.auth.uid).update({ failedAttempts: newAttempts });
        throw new HttpsError("invalid-argument", `Invalid OTP. ${3 - newAttempts} attempts remaining.`);
      }
    }

    // Delete OTP successfully consumed
    await db.collection("refundOtps").doc(request.auth.uid).delete();

    // Fetch the order
    const orderDoc = await db.collection("orders").doc(orderId).get();
    if (!orderDoc.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }

    const orderData = orderDoc.data()!;

    // Ensure order has a payment to refund
    if (!orderData.razorpayPaymentId) {
      throw new HttpsError(
        "failed-precondition",
        "This order has no captured payment. Cannot issue refund."
      );
    }

    // Check if already refunded
    if (orderData.refundId && orderData.refundStatus !== "FAILED") {
      throw new HttpsError(
        "already-exists",
        `Refund already issued for this order (Refund ID: ${orderData.refundId}, Status: ${orderData.refundStatus}).`
      );
    }

    const { executeSafeRefund } = await import("./refundLifecycle");
    const ip = request.rawRequest?.ip || request.rawRequest?.headers['x-forwarded-for'] || "127.0.0.1";

    const { success, message } = await executeSafeRefund({
      orderId,
      razorpayPaymentId: orderData.razorpayPaymentId,
      shopId: orderData.shopId,
      reason: reason || "Admin-initiated manual refund",
      actorUid: request.auth.uid,
      source: "ADMIN",
      ipAddress: Array.isArray(ip) ? ip[0] : ip,
    });

    if (!success) {
      throw new HttpsError("internal", message || "Refund execution failed internally. Request flagged for intervention.");
    }

    return {
      success: true,
      message: message || "Refund initiated successfully."
    };
  }
);

/**
 * createPassOrder — Creates a Razorpay order for Student Pass purchase.
 */
export const createPassOrder = onCall(
  { region: "asia-south1", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    // Verify user is a student
    const userDoc = await db
      .collection("users")
      .doc(request.auth.uid)
      .get();
    if (!userDoc.exists) {
      throw new HttpsError("not-found", "User profile not found.");
    }

    const userData = userDoc.data()!;
    if (userData.type !== "STUDENT") {
      throw new HttpsError(
        "permission-denied",
        "Only students can purchase a Student Pass."
      );
    }

    if (userData.hasStudentPass === true && userData.studentPassActivatedAt) {
      const activatedAt = new Date(userData.studentPassActivatedAt).getTime();
      const expiryDate = activatedAt + 30 * 24 * 60 * 60 * 1000;
      if (Date.now() < expiryDate) {
        throw new HttpsError(
          "failed-precondition",
          "You already have an active Student Pass."
        );
      }
      // Pass has expired — allow renewal
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
  }
);

/**
 * verifyPassPayment — Verifies Student Pass payment and activates the pass.
 */
export const verifyPassPayment = onCall(
  { region: "asia-south1", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = request.data;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      throw new HttpsError(
        "invalid-argument",
        "Missing payment verification parameters."
      );
    }

    // Verify signature
    const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
    const generatedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      throw new HttpsError(
        "failed-precondition",
        "Payment verification failed. Signature mismatch."
      );
    }

    // Verify via Razorpay API to prevent signature spoofing (Bug 3)
    try {
      const payment = await getRazorpay().payments.fetch(razorpay_payment_id);
      if (payment.amount !== 4900) {
        throw new HttpsError("failed-precondition", "Payment amount mismatch. Expected ₹49.");
      }

      const rzpOrder = await getRazorpay().orders.fetch(razorpay_order_id);
      if (rzpOrder.notes?.type !== "student_pass") {
        throw new HttpsError("failed-precondition", "Invalid order type. Expected student_pass.");
      }

      // Prevent Cross-Account Replay Attacks by enforcing identity matching
      if (rzpOrder.notes?.userId !== request.auth.uid) {
        throw new HttpsError("permission-denied", "This payment receipt belongs to a different user account.");
      }
    } catch (apiError: any) {
      if (apiError instanceof HttpsError) throw apiError;
      logger.error(`[verifyPassPayment] Razorpay API verification failed:`, apiError.message);
      throw new HttpsError("internal", `Payment verification check failed: ${apiError.message}`);
    }

    // Activate Student Pass
    await db.collection("users").doc(request.auth.uid).update({
      hasStudentPass: true,
      studentPassPaymentId: razorpay_payment_id,
      studentPassActivatedAt: new Date().toISOString(),
    });

    return { success: true, message: "Student Pass activated successfully!" };
  }
);

/**
 * onOrderStatusChange — Firestore trigger that auto-deletes uploaded files from
 * Firebase Storage when an order is marked as COMPLETED or CANCELLED.
 * This is a production safety net — the client also attempts deletion,
 * but this ensures cleanup even if the client fails.
 */
export const onOrderStatusChange = onDocumentUpdated(
  { document: "orders/{orderId}", region: "asia-south1" },
  async (event) => {
    const beforeData = event.data?.before.data();
    const afterData = event.data?.after.data();

    if (!beforeData || !afterData) return;

    const oldStatus = beforeData.status;
    const newStatus = afterData.status;

    // Only trigger on actual status transitions
    if (oldStatus === newStatus) return;

    const orderId = event.params.orderId;
    const orderShortId = orderId.slice(-6);
    const fileName = afterData.fileName || "document";

    // --- PUSH NOTIFICATIONS for all status transitions ---
    try {

      if (newStatus === "PENDING_APPROVAL") {
        await sendPushToUser(
          afterData.userId,
          "Payment Confirmed! ✅",
          `Order #${orderShortId} (${fileName}) — payment verified. Your print is queued.`,
          { orderId, type: "order_status" }
        );
        // Also notify the shopkeeper about the new paid order
        await sendPushToShop(
          afterData.shopId,
          "New Paid Order! 🖨️",
          `Order #${orderShortId} (${fileName}) — ₹${afterData.priceDetails?.totalPrice?.toFixed(2) || "?"} paid. Ready to print.`,
          { orderId, type: "new_order" }
        );

        // Bug 12: DB notifications
        await db.collection("notifications").add({
          message: `Order #${orderShortId} (${fileName}) at shop is now pending approval.`,
          type: "success",
          orderId,
          recipientUserId: afterData.userId,
          read: false,
          timestamp: new Date().toISOString(),
        });

        const shopDoc = await db.collection("shops").doc(afterData.shopId).get();
        if (shopDoc.exists) {
          await db.collection("notifications").add({
            message: `Order #${orderShortId} (${fileName}) by ${afterData.userName || "Student"} is now pending approval.`,
            type: "success",
            orderId,
            targetShopId: afterData.shopId,
            recipientUserId: shopDoc.data()!.ownerUserId,
            read: false,
            timestamp: new Date().toISOString(),
          });
        }
      } else if (newStatus === "PRINTING") {
        await sendPushToUser(
          afterData.userId,
          "Printing Started 🖨️",
          `Order #${orderShortId} (${fileName}) is now being printed.`,
          { orderId, type: "order_status" }
        );
      } else if (newStatus === "READY_FOR_PICKUP") {
        const pickupCode = afterData.pickupCode || "";
        await sendPushToUser(
          afterData.userId,
          "Ready for Pickup! 📦",
          `Order #${orderShortId} is ready! ${pickupCode ? `Pickup code: ${pickupCode}` : "Show your order ID."}`,
          { orderId, type: "order_status", pickupCode }
        );

        // Bug 12: DB Notification
        await db.collection("notifications").add({
          message: `Order #${orderShortId} (${fileName}) at shop is now ready for pickup. Pickup code: ${pickupCode}`,
          type: "success",
          orderId,
          recipientUserId: afterData.userId,
          read: false,
          timestamp: new Date().toISOString(),
        });
      } else if (newStatus === "COMPLETED") {
        // SECURITY FIX: Prevent fraudulent earnings credit for unpaid orders force-completed by malicious shops
        const validPreviousStatuses = ["PENDING_APPROVAL", "PRINTING", "READY_FOR_PICKUP"];
        if (!validPreviousStatuses.includes(oldStatus)) {
          logger.warn(`[onOrderStatusChange] Fraud attempts blocked: Invalid transition to COMPLETED for order ${orderId}. Old status: ${oldStatus}`);
          return;
        }

        if (!afterData.razorpayPaymentId) {
          logger.warn(`[onOrderStatusChange] Fraud attempts blocked: Order ${orderId} missing payment ID. Cannot credit ledger.`);
          return;
        }

        await sendPushToUser(
          afterData.userId,
          "Order Complete ✅",
          `Order #${orderShortId} (${fileName}) has been completed. Thank you!`,
          { orderId, type: "order_status" }
        );

        // Add Ledger Credit (Deterministic doc ID prevents duplicates on retry)
        try {
          const ledgerRef = db.collection('shopLedger').doc(`earn_${orderId}`);
          await db.runTransaction(async (tx) => {
            const shopRef = db.collection('shops').doc(afterData.shopId);
            const shopDoc = await tx.get(shopRef);
            const currentPending = shopDoc.data()?.pendingBalance || 0;

            // Idempotency guard: if this earning already exists, skip
            const existingEntry = await tx.get(ledgerRef);
            if (existingEntry.exists) {
              logger.warn(`[onOrderStatusChange] Ledger entry earn_${orderId} already exists. Skipping duplicate.`);
              return;
            }

            tx.set(ledgerRef, {
              id: ledgerRef.id,
              eventId: `earn_${orderId}`,
              shopId: afterData.shopId,
              orderId: orderId,
              type: 'ORDER_EARNING',
              status: 'PENDING',        // Settles after 24h
              amount: afterData.priceDetails.pageCost,
              counterparty: 'STUDENT',  // Student paid → shop earns
              description: `Earning from order #${orderShortId}`,
              createdBy: 'SYSTEM',
              createdAt: new Date().toISOString(),
            });

            tx.update(shopRef, {
              pendingBalance: currentPending + afterData.priceDetails.pageCost,
              financialVersion: admin.firestore.FieldValue.increment(1),
            });

            // Store ledger reference on the order document directly
            tx.update(db.collection('orders').doc(orderId), {
              ledgerEntryId: ledgerRef.id,
              completedAt: new Date().toISOString(),
            });
          });
          logger.info("EARNING_PENDING_CREATED", {
            event: "EARNING_PENDING_CREATED",
            orderId,
            shopId: afterData.shopId,
            amount: afterData.priceDetails.pageCost,
            timestamp: Date.now()
          });
        } catch (ledgerError: any) {
          logger.error(`[onOrderStatusChange] Failed to create ledger entry for complete order:`, ledgerError.message);
        }
      } else if (newStatus === "CANCELLED") {
        await sendPushToUser(
          afterData.userId,
          "Order Cancelled ❌",
          `Order #${orderShortId} (${fileName}) has been cancelled.${afterData.shopNotes ? " Reason: " + afterData.shopNotes : ""}`,
          { orderId, type: "order_status" }
        );

        // Bug 12: DB Notification
        let studentMessage = `Order #${orderShortId} has been cancelled by the shop.`;
        if (afterData.shopNotes) studentMessage += ` Reason: ${afterData.shopNotes}`;
        await db.collection("notifications").add({
          message: studentMessage,
          type: "warning",
          orderId,
          recipientUserId: afterData.userId,
          read: false,
          timestamp: new Date().toISOString(),
        });
      } else if (newStatus === "PAYMENT_FAILED") {
        await sendPushToUser(
          afterData.userId,
          "Payment Failed ⚠️",
          `Payment failed for order #${orderShortId}. Please try again.`,
          { orderId, type: "order_status" }
        );

        // Bug 12: DB Notification
        await db.collection("notifications").add({
          message: `Order #${orderShortId} (${fileName}) at shop is now payment failed.`,
          type: "error",
          orderId,
          recipientUserId: afterData.userId,
          read: false,
          timestamp: new Date().toISOString(),
        });

        const shopDoc = await db.collection("shops").doc(afterData.shopId).get();
        if (shopDoc.exists) {
          await db.collection("notifications").add({
            message: `Order #${orderShortId} (${fileName}) by ${afterData.userName || "Student"} is now payment failed.`,
            type: "error",
            orderId,
            targetShopId: afterData.shopId,
            recipientUserId: shopDoc.data()!.ownerUserId,
            read: false,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (pushError: any) {
      // Push notification failures should never break the main flow
      logger.error(`[onOrderStatusChange] Push notification error:`, pushError.message);
    }

    // --- AUTO-REFUND & FILE CLEANUP: Only for COMPLETED or CANCELLED ---
    if (newStatus !== "COMPLETED" && newStatus !== "CANCELLED") return;

    // --- AUTO-REFUND: Issue Razorpay refund when a PAID order is CANCELLED ---
    // Only refund if the order was actually paid (had reached PENDING_APPROVAL or beyond)
    // PAYMENT_FAILED orders may have a razorpayPaymentId from a failed attempt that was never captured
    const PAID_STATUSES = ["PENDING_APPROVAL", "PRINTING", "READY_FOR_PICKUP", "COMPLETED"];
    const wasTrulyPaid = afterData.razorpayPaymentId && PAID_STATUSES.includes(oldStatus);
    if (newStatus === "CANCELLED" && wasTrulyPaid) {
      logger.info(`[onOrderStatusChange] Order #${orderId.slice(-6)} cancelled (was ${oldStatus}) with payment ${afterData.razorpayPaymentId}. Initiating automatic refund...`);

      try {
        const { executeSafeRefund } = await import("./refundLifecycle");

        await executeSafeRefund({
          orderId,
          razorpayPaymentId: afterData.razorpayPaymentId,
          shopId: afterData.shopId,
          reason: "Order systematically cancelled",
          actorUid: "SYSTEM",
          source: "SYSTEM",
          ipAddress: "127.0.0.1",
        });

        logger.info(`[onOrderStatusChange] executeSafeRefund succeeded for #${orderId.slice(-6)}.`);

        // Create a notification for the student about the refund
        try {
          // Send notification specifying the actual amount that was refunded (100% of price)
          const refundAmountDisplay = afterData.priceDetails?.totalPrice ? afterData.priceDetails.totalPrice.toFixed(2) : "0.00";
          await db.collection("notifications").add({
            message: `Refund of ₹${refundAmountDisplay} has been initiated for cancelled order #${orderId.slice(-6)}. It will be credited to your original payment method within 5-7 business days.`,
            type: "info",
            recipientUserId: afterData.userId,
            orderId: orderId,
            read: false,
            timestamp: new Date().toISOString(),
          });
        } catch (notifError: any) {
          logger.warn(`[onOrderStatusChange] Failed to create refund notification:`, notifError.message);
        }
      } catch (refundError: any) {
        logger.error(`[onOrderStatusChange] REFUND FAILED for order #${orderId.slice(-6)}, payment ${afterData.razorpayPaymentId}:`, refundError.message);

        // Mark order as needing manual refund so admin can investigate
        await db.collection("orders").doc(orderId).update({
          refundStatus: "FAILED",
          refundError: refundError.message || "Unknown refund error",
          refundedAt: new Date().toISOString(),
        });

        // Notify admin about the failed refund
        try {
          const adminsSnap = await db.collection("users").where("type", "==", "ADMIN").get();
          const batch = db.batch();
          const nowTimestamp = new Date().toISOString();

          for (const doc of adminsSnap.docs) {
            batch.set(db.collection("notifications").doc(), {
              message: `⚠️ AUTO-REFUND FAILED for order #${orderId.slice(-6)} (Payment: ${afterData.razorpayPaymentId}). Manual refund required. Error: ${refundError.message}`,
              type: "error",
              recipientUserId: doc.id,
              read: false,
              timestamp: nowTimestamp,
            });
          }

          // Also notify the student so they can contact support
          batch.set(db.collection("notifications").doc(), {
            message: `⚠️ Auto-refund failed for order #${orderId.slice(-6)}. Please contact support for a manual refund.`,
            type: "error",
            recipientUserId: afterData.userId,
            read: false,
            timestamp: nowTimestamp,
          });

          await batch.commit();
        } catch (notifError: unknown) {
          logger.warn(`[onOrderStatusChange] Failed to create refund-failure notifications`, notifError);
        }
      }
    }

    // --- FILE CLEANUP: Delete uploaded files from Storage ---
    const bucket = admin.storage().bucket();
    const filesArray = afterData.files as OrderFileData[] | undefined;

    if (filesArray && filesArray.length > 0) {
      // Multi-file order: delete all files
      for (const fileEntry of filesArray) {
        if (fileEntry.fileStoragePath && !fileEntry.isFileDeleted && fileEntry.fileStoragePath.startsWith(`orders/${afterData.userId}/`) && !fileEntry.fileStoragePath.includes("..")) {
          try {
            const storageFile = bucket.file(fileEntry.fileStoragePath);
            const [exists] = await storageFile.exists();
            if (exists) {
              await storageFile.delete();
              logger.info(`[onOrderStatusChange] Deleted file: ${fileEntry.fileStoragePath} for order ${orderId}`);
            }
            // (Note: we don't update individual `isFileDeleted` flags here to avoid trigger loops; 
            // the whole document flag is updated below)
          } catch (storageError: any) {
            logger.error(`[onOrderStatusChange] Failed to delete file: ${fileEntry.fileStoragePath}`, storageError.message);
          }
        } else if (fileEntry.fileStoragePath && !fileEntry.isFileDeleted) {
          logger.warn(`[onOrderStatusChange] Security block: Refused to delete untrusted path ${fileEntry.fileStoragePath}`);
        }
      }
      // Mark all files as deleted
      const updatedFiles = filesArray.map(f => ({ ...f, isFileDeleted: true }));
      await db.collection("orders").doc(orderId).update({
        files: updatedFiles,
        isFileDeleted: true,
      });
    } else {
      // Legacy single-file order
      const fileStoragePath = afterData.fileStoragePath;
      const isFileDeleted = afterData.isFileDeleted;

      if (fileStoragePath && !isFileDeleted) {
        if (fileStoragePath.startsWith(`orders/${afterData.userId}/`) && !fileStoragePath.includes("..")) {
          try {
            const storageFile = bucket.file(fileStoragePath);
            const [exists] = await storageFile.exists();
            if (exists) {
              await storageFile.delete();
              logger.info(`[onOrderStatusChange] Deleted single file: ${fileStoragePath} for order ${orderId}`);
            }
            await db.collection("orders").doc(orderId).update({ isFileDeleted: true });
          } catch (error: any) {
            logger.error(`[onOrderStatusChange] Failed to delete file for order ${orderId}:`, error.message);
          }
        } else {
          logger.warn(`[onOrderStatusChange] Security block: Refused to delete untrusted legacy path ${fileStoragePath}`);
        }
      } else {
        logger.info(`[onOrderStatusChange] No file to clean up for order ${orderId}`);
      }
    }
  }
);

/**
 * cleanupAbandonedOrders — Scheduled CRON job that runs every hour.
 * Scans for orders stuck in PENDING_PAYMENT or PAYMENT_FAILED for more than 2 hours,
 * deletes their uploaded files from Firebase Storage, and marks them CANCELLED.
 * This prevents the "ghost file" storage cost attack.
 */
export const cleanupAbandonedOrders = onSchedule(
  {
    schedule: "every 1 hours",
    region: "asia-south1",
    timeoutSeconds: 300,
  },
  async () => {
    const cutoffTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

    logger.info(`[cleanupAbandonedOrders] Running cleanup. Cutoff time: ${cutoffTime}`);

    try {
      // SECURITY: Only clean up PENDING_PAYMENT orders.
      // PAYMENT_FAILED orders must NOT be auto-cancelled because Razorpay may have
      // captured the payment even though client-side verification failed.
      // Those require server-side reconciliation before deletion.
      const abandonedOrdersSnapshot = await db
        .collection("orders")
        .where("status", "==", "PENDING_PAYMENT")
        .where("uploadedAt", "<", cutoffTime)
        .get();

      if (abandonedOrdersSnapshot.empty) {
        logger.info("[cleanupAbandonedOrders] No abandoned orders found.");
        return;
      }

      logger.info(`[cleanupAbandonedOrders] Found ${abandonedOrdersSnapshot.size} abandoned order(s).`);

      const bucket = admin.storage().bucket();
      let deletedCount = 0;
      let errorCount = 0;

      for (const orderDoc of abandonedOrdersSnapshot.docs) {
        const orderData = orderDoc.data();
        const orderId = orderDoc.id;

        try {
          // Delete all files from Storage (multi-file or legacy)
          const filesArr = orderData.files as OrderFileData[] | undefined;
          if (filesArr && filesArr.length > 0) {
            for (const fileEntry of filesArr) {
              if (fileEntry.fileStoragePath && !fileEntry.isFileDeleted) {
                if (fileEntry.fileStoragePath.startsWith(`orders/${orderData.userId}/`) && !fileEntry.fileStoragePath.includes("..")) {
                  const storageFile = bucket.file(fileEntry.fileStoragePath);
                  const [exists] = await storageFile.exists();
                  if (exists) {
                    await storageFile.delete();
                    logger.info(`[cleanupAbandonedOrders] Deleted file: ${fileEntry.fileStoragePath}`);
                  }
                } else {
                  logger.warn(`[cleanupAbandonedOrders] Security block: Refused to delete untrusted path ${fileEntry.fileStoragePath}`);
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
          } else {
            // Legacy single-file cleanup
            if (orderData.fileStoragePath && !orderData.isFileDeleted) {
              if (orderData.fileStoragePath.startsWith(`orders/${orderData.userId}/`) && !orderData.fileStoragePath.includes("..")) {
                const storageFile = bucket.file(orderData.fileStoragePath);
                const [exists] = await storageFile.exists();
                if (exists) {
                  await storageFile.delete();
                  logger.info(`[cleanupAbandonedOrders] Deleted file: ${orderData.fileStoragePath}`);
                }
              } else {
                logger.warn(`[cleanupAbandonedOrders] Security block: Refused to delete untrusted path ${orderData.fileStoragePath}`);
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
          logger.info(`[cleanupAbandonedOrders] Cancelled abandoned order #${orderId.slice(-6)}`);
        } catch (orderError: any) {
          errorCount++;
          logger.error(`[cleanupAbandonedOrders] Error processing order ${orderId}:`, orderError.message);
        }
      }

      logger.info(`[cleanupAbandonedOrders] Cleanup complete. Cancelled: ${deletedCount}, Errors: ${errorCount}`);
    } catch (error: any) {
      logger.error("[cleanupAbandonedOrders] Fatal error during cleanup:", error.message);
    }
  }
);

/**
 * settleShopEarnings — Scheduled job runs every 6 hours
 * Moves PENDING ledger entries older than 24 hours to SETTLED status
 * Updates shop.pendingBalance -> shop.ledgerBalance safely
 */
export const settleShopEarnings = onSchedule(
  { schedule: "every 6 hours", region: "asia-south1", timeoutSeconds: 300 },
  async () => {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let processedBatches = 0;
    let totalProcessedEntries = 0;

    let hasMoreEntries = true;
    while (hasMoreEntries) {
      const pendingEntriesSnap = await db.collection('shopLedger')
        .where('status', '==', 'PENDING')
        .where('createdAt', '<=', cutoff)
        .limit(200)
        .get();

      if (pendingEntriesSnap.empty) {
        hasMoreEntries = false;
        if (processedBatches === 0) {
          logger.info("[settleShopEarnings] No pending entries to settle.");
        } else {
          logger.info(`[settleShopEarnings] Completed ${processedBatches} batch(es), settling ${totalProcessedEntries} entries total.`);
        }
        continue;
      }

      processedBatches++;

      const byShop = new Map<string, typeof pendingEntriesSnap.docs>();
      for (const doc of pendingEntriesSnap.docs) {
        const shopId = doc.data().shopId;
        if (!byShop.has(shopId)) byShop.set(shopId, []);
        byShop.get(shopId)!.push(doc);
      }

      logger.info(`[settleShopEarnings] Processing batch ${processedBatches}: ${pendingEntriesSnap.size} entries across ${byShop.size} shops.`);

      for (const [shopId, entries] of byShop) {
        try {
          const settledEntryCount = await db.runTransaction(async (tx) => {
            const shopRef = db.collection('shops').doc(shopId);
            const shopDoc = await tx.get(shopRef);
            if (!shopDoc.exists) return 0;

            let settleSum = 0;
            let batchSettledEntryCount = 0;
            const now = new Date().toISOString();

            for (const entry of entries) {
              const freshEntry = await tx.get(entry.ref);
              if (!freshEntry.exists || freshEntry.data()?.status !== 'PENDING') continue;

              settleSum += freshEntry.data()!.amount;
              batchSettledEntryCount++;
              tx.update(entry.ref, {
                status: 'SETTLED',
                settledAt: now
              });
            }

            if (settleSum > 0) {
              const currentPending = shopDoc.data()!.pendingBalance || 0;
              const currentLedger = Math.max(0, shopDoc.data()!.ledgerBalance || 0);
              const currentDebt = shopDoc.data()!.debtAmount || 0;
              const recoveredDebt = Math.min(currentDebt, settleSum);
              const netLedgerCredit = settleSum - recoveredDebt;

              tx.update(shopRef, {
                pendingBalance: Math.max(0, currentPending - settleSum),
                ledgerBalance: currentLedger + netLedgerCredit,
                debtAmount: Math.max(0, currentDebt - recoveredDebt),
                lastSettlementAt: now,
                financialVersion: admin.firestore.FieldValue.increment(1),
              });


              logger.info("SETTLEMENT_COMPLETED", {
                event: "SETTLEMENT_COMPLETED",
                shopId,
                settledAmount: settleSum,
                recoveredDebt,
                entryCount: batchSettledEntryCount,
                timestamp: Date.now()
              });
            }
            return batchSettledEntryCount;
          });
          totalProcessedEntries += settledEntryCount;
        } catch (err: any) {
          logger.error("SETTLEMENT_FAILED", { shopId, error: err.message });
        }
      }
    }
  }
);

/**
 * onNewOrder — Push notification to shopkeeper when a new order is created.
 * Triggers when an order document is first written to Firestore.
 */
export const onNewOrder = onDocumentCreated(
  { document: "orders/{orderId}", region: "asia-south1" },
  async (event) => {
    const orderData = event.data?.data();
    if (!orderData) return;

    const orderId = event.params.orderId;
    const orderShortId = orderId.slice(-6);
    const fileName = orderData.fileName || "document";
    const fileCount = orderData.files?.length || 1;
    const totalPrice = orderData.priceDetails?.totalPrice?.toFixed(2) || "?";

    const fileLabel = fileCount === 1 ? fileName : `${fileCount} files`;

    // Only send push to shopkeeper once the order is actually paid.
    // PENDING_PAYMENT orders are drafts — shopkeeper will be notified
    // via the onOrderStatusChange trigger when payment succeeds.
    try {
      // DB notification for the student only (order placed, proceed to pay)
      await db.collection("notifications").add({
        message: `Order #${orderShortId} for ${fileLabel} (₹${totalPrice}) placed. Proceed to payment.`,
        type: "info",
        orderId,
        recipientUserId: orderData.userId,
        read: false,
        timestamp: new Date().toISOString(),
      });

    } catch (error: any) {
      logger.error(`[onNewOrder] Notification error:`, error.message);
    }
  }
);

export const syncShopAggregateOnOrderWrite = onDocumentWritten(
  { document: "orders/{orderId}", region: "asia-south1" },
  async (event) => {
    const beforeShopId = event.data?.before.data()?.shopId;
    const afterShopId = event.data?.after.data()?.shopId;
    const shopIds = [...new Set([beforeShopId, afterShopId].filter((value): value is string => typeof value === "string" && value.length > 0))];

    await Promise.all(shopIds.map((shopId) => syncShopAggregate(shopId)));
  }
);

export const syncShopAggregateOnPayoutWrite = onDocumentWritten(
  { document: "payouts/{payoutId}", region: "asia-south1" },
  async (event) => {
    const beforeShopId = event.data?.before.data()?.shopId;
    const afterShopId = event.data?.after.data()?.shopId;
    const shopIds = [...new Set([beforeShopId, afterShopId].filter((value): value is string => typeof value === "string" && value.length > 0))];

    await Promise.all(shopIds.map((shopId) => syncShopAggregate(shopId)));
  }
);

export const rebuildShopAggregates = onCall(
  { region: "asia-south1" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const adminDoc = await db.collection("users").doc(request.auth.uid).get();
    if (!adminDoc.exists || adminDoc.data()?.type !== "ADMIN") {
      throw new HttpsError("permission-denied", "Only admins can rebuild shop aggregates.");
    }

    const shopsSnap = await db.collection("shops").get();
    const shopIds = shopsSnap.docs.map((docSnap) => docSnap.id);

    for (let i = 0; i < shopIds.length; i += 10) {
      const batch = shopIds.slice(i, i + 10);
      await Promise.all(batch.map((shopId) => syncShopAggregate(shopId)));
    }

    return {
      success: true,
      updatedCount: shopIds.length,
    };
  }
);

/**
 * cleanupOldNotifications — Scheduled CRON job that runs every 12 hours.
 * Deletes:
 *   - READ notifications older than 2 days
 *   - ALL notifications older than 30 days (regardless of read status)
 * Uses batched deletes (max 500 per batch) for efficiency.
 */
export const cleanupOldNotifications = onSchedule(
  {
    schedule: "every 12 hours",
    region: "asia-south1",
    timeoutSeconds: 120,
  },
  async () => {
    const now = Date.now();
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    logger.info(`[cleanupOldNotifications] Running. Read cutoff: ${twoDaysAgo}, Unread cutoff: ${thirtyDaysAgo}`);

    let totalDeleted = 0;

    try {
      // 1. Delete READ notifications older than 2 days
      let readQuery = await db
        .collection("notifications")
        .where("read", "==", true)
        .where("timestamp", "<", twoDaysAgo)
        .limit(500)
        .get();

      while (!readQuery.empty) {
        const batch = db.batch();
        readQuery.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        totalDeleted += readQuery.size;
        logger.info(`[cleanupOldNotifications] Deleted ${readQuery.size} read notifications (>2 days old)`);
        readQuery = await db
          .collection("notifications")
          .where("read", "==", true)
          .where("timestamp", "<", twoDaysAgo)
          .limit(500)
          .get();
      }

      // 2. Delete ALL notifications older than 30 days (safety cleanup)
      let oldQuery = await db
        .collection("notifications")
        .where("timestamp", "<", thirtyDaysAgo)
        .limit(500)
        .get();

      while (!oldQuery.empty) {
        const batch = db.batch();
        oldQuery.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        totalDeleted += oldQuery.size;
        logger.info(`[cleanupOldNotifications] Deleted ${oldQuery.size} old notifications (>30 days)`);
        oldQuery = await db
          .collection("notifications")
          .where("timestamp", "<", thirtyDaysAgo)
          .limit(500)
          .get();
      }

      logger.info(`[cleanupOldNotifications] Cleanup complete. Total deleted: ${totalDeleted}`);
    } catch (error: any) {
      logger.error("[cleanupOldNotifications] Error:", error.message);
    }
  }
);


// ---------- TICKET FILE CLEANUP ----------

/**
 * onTicketStatusChange — When a ticket is RESOLVED or CLOSED,
 * delete any uploaded attachment files from Firebase Storage.
 */
export const onTicketStatusChange = onDocumentUpdated(
  { document: "tickets/{ticketId}", region: "asia-south1" },
  async (event) => {
    const beforeData = event.data?.before.data();
    const afterData = event.data?.after.data();

    if (!beforeData || !afterData) return;

    const oldStatus = beforeData.status;
    const newStatus = afterData.status;

    // Only trigger on actual status transitions to closed/resolved
    if (oldStatus === newStatus) return;
    if (newStatus !== "RESOLVED" && newStatus !== "CLOSED") return;

    const ticketId = event.params.ticketId;
    const attachmentPaths: string[] = afterData.attachmentPaths || [];

    if (attachmentPaths.length === 0) {
      logger.info(`[onTicketStatusChange] Ticket ${ticketId} has no attachments to clean up.`);
      return;
    }

    const bucket = admin.storage().bucket();
    let deletedCount = 0;

    for (const filePath of attachmentPaths) {
      if (filePath && filePath.startsWith(`tickets/${ticketId}/`) && !filePath.includes('..')) {
        try {
          const storageFile = bucket.file(filePath);
          const [exists] = await storageFile.exists();
          if (exists) {
            await storageFile.delete();
            deletedCount++;
            logger.info(`[onTicketStatusChange] Deleted ticket attachment: ${filePath}`);
          }
        } catch (error: any) {
          logger.error(`[onTicketStatusChange] Failed to delete file at ${filePath}`, error.message);
        }
      } else {
        logger.warn(`[onTicketStatusChange] Security block: Refused to delete untrusted path ${filePath}`);
      }
    }

    // Clear attachment paths from the ticket document
    await db.collection("tickets").doc(ticketId).update({
      attachmentPaths: [],
      attachmentsCleanedAt: new Date().toISOString(),
    });

    logger.info(`[onTicketStatusChange] Cleaned up ${deletedCount} attachment(s) for ticket ${ticketId}`);
  }
);

/**
 * cleanupOldTickets — Scheduled CRON job that runs daily.
 * Deletes RESOLVED/CLOSED tickets older than 90 days.
 */
export const cleanupOldTickets = onSchedule(
  {
    schedule: "every 24 hours",
    region: "asia-south1",
    timeoutSeconds: 300,
  },
  async () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    logger.info(`[cleanupOldTickets] Running. Cutoff: ${ninetyDaysAgo}`);

    let totalDeleted = 0;

    try {
      for (const closedStatus of ["RESOLVED", "CLOSED"]) {
        let snapshot = await db
          .collection("tickets")
          .where("status", "==", closedStatus)
          .where("updatedAt", "<", ninetyDaysAgo)
          .limit(500)
          .get();

        while (!snapshot.empty) {
          const batch = db.batch();
          snapshot.docs.forEach((doc) => batch.delete(doc.ref));
          await batch.commit();
          totalDeleted += snapshot.size;
          snapshot = await db
            .collection("tickets")
            .where("status", "==", closedStatus)
            .where("updatedAt", "<", ninetyDaysAgo)
            .limit(500)
            .get();
        }
      }
      logger.info(`[cleanupOldTickets] Deleted ${totalDeleted} old ticket(s).`);
    } catch (error: any) {
      logger.error(`[cleanupOldTickets] Error:`, error.message);
    }
  }
);

// ---------- EARNINGS REPORT GENERATION ----------

/**
 * generateEarningsReport — Callable function for admin to generate
 * an Excel earnings report for a date range. Stores in Firebase Storage
 * and saves metadata to Firestore 'reports' collection.
 */
export const generateEarningsReport = onCall(
  { region: "asia-south1", cors: true, timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    // Verify admin
    const userDoc = await db.collection("users").doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data()!.type !== "ADMIN") {
      throw new HttpsError("permission-denied", "Only admins can generate reports.");
    }

    const { startDate, endDate, reportType } = request.data;
    if (!startDate || !endDate) {
      throw new HttpsError("invalid-argument", "startDate and endDate are required.");
    }

    logger.info(`[generateEarningsReport] Generating ${reportType || 'full'} report: ${startDate} to ${endDate}`);

    // Fetch completed orders in the date range
    const ordersSnap = await db.collection("orders")
      .where("status", "==", "COMPLETED")
      .where("completedAt", ">=", startDate)
      .where("completedAt", "<=", endDate)
      .get();

    const shopMap: Record<string, string> = {};
    const referencedShopIds = [...new Set(
      ordersSnap.docs
        .map((docSnap) => docSnap.data().shopId)
        .filter((shopId): shopId is string => typeof shopId === "string" && shopId.length > 0)
    )];
    const referencedShopDocs = await Promise.all(
      referencedShopIds.map((shopId) => db.collection("shops").doc(shopId).get())
    );
    referencedShopDocs.forEach((docSnap) => {
      if (docSnap.exists) {
        shopMap[docSnap.id] = docSnap.data()?.name || "Unknown Shop";
      }
    });

    // Build Excel
    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "EzyPrint Admin";
    workbook.created = new Date();

    // --- Sheet 1: Order Details ---
    const orderSheet = workbook.addWorksheet("Order Details");
    orderSheet.columns = [
      { header: "Order ID", key: "orderId", width: 18 },
      { header: "Date", key: "date", width: 14 },
      { header: "Shop", key: "shopName", width: 20 },
      { header: "Student", key: "studentName", width: 20 },
      { header: "File(s)", key: "fileName", width: 25 },
      { header: "Pages", key: "pages", width: 8 },
      { header: "Copies", key: "copies", width: 8 },
      { header: "Color", key: "color", width: 10 },
      { header: "Page Cost (₹)", key: "pageCost", width: 14 },
      { header: "Base Fee (₹)", key: "baseFee", width: 12 },
      { header: "Total (₹)", key: "total", width: 12 },
      { header: "Premium", key: "isPremium", width: 10 },
    ];

    // Style header row
    orderSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFF" } };
    orderSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "4F46E5" } };

    let totalRevenue = 0;
    let totalBaseFees = 0;
    let totalPageCosts = 0;
    const shopEarnings: Record<string, { name: string; pageCost: number; baseFee: number; total: number; orderCount: number }> = {};

    ordersSnap.docs.forEach(doc => {
      const d = doc.data();
      const pageCost = d.priceDetails?.pageCost || 0;
      const baseFee = d.priceDetails?.baseFee || 0;
      const total = d.priceDetails?.totalPrice || 0;
      const shopName = shopMap[d.shopId] || d.shopName || "Unknown";

      totalRevenue += total;
      totalBaseFees += baseFee;
      totalPageCosts += pageCost;

      if (!shopEarnings[d.shopId]) {
        shopEarnings[d.shopId] = { name: shopName, pageCost: 0, baseFee: 0, total: 0, orderCount: 0 };
      }
      shopEarnings[d.shopId].pageCost += pageCost;
      shopEarnings[d.shopId].baseFee += baseFee;
      shopEarnings[d.shopId].total += total;
      shopEarnings[d.shopId].orderCount++;

      // Determine file info
      const files = d.files as OrderFileData[] | undefined;
      let fileNames = d.fileName || "Unknown";
      let totalPages = d.printOptions?.pages || 0;
      let totalCopies = d.printOptions?.copies || 0;
      let colorType = d.printOptions?.color || "BW";

      if (files && files.length > 0) {
        fileNames = files.map(f => f.fileName).join(", ");
        totalPages = files.reduce((sum: number, f: OrderFileData) => sum + f.pageCount, 0);
        totalCopies = files.reduce((sum: number, f: OrderFileData) => sum + f.copies, 0);
        colorType = files.some(f => f.color === "COLOR") ? "Mixed" : "BW";
      }

      orderSheet.addRow({
        orderId: doc.id.slice(-10),
        date: new Date(d.completedAt || d.uploadedAt).toLocaleDateString("en-IN"),
        shopName,
        studentName: d.userName || "Unknown",
        fileName: fileNames,
        pages: totalPages,
        copies: totalCopies,
        color: colorType,
        pageCost: pageCost.toFixed(2),
        baseFee: baseFee.toFixed(2),
        total: total.toFixed(2),
        isPremium: d.isPremiumOrder ? "Yes" : "No",
      });
    });

    // --- Sheet 2: Shop-wise Summary ---
    const summarySheet = workbook.addWorksheet("Shop Summary");
    summarySheet.columns = [
      { header: "Shop Name", key: "shopName", width: 25 },
      { header: "Orders", key: "orderCount", width: 10 },
      { header: "Page Cost (₹)", key: "pageCost", width: 14 },
      { header: "Base Fees (₹)", key: "baseFee", width: 14 },
      { header: "Total Revenue (₹)", key: "total", width: 16 },
      { header: "Platform Earnings (₹)", key: "platformEarnings", width: 18 },
    ];

    summarySheet.getRow(1).font = { bold: true, color: { argb: "FFFFFF" } };
    summarySheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "059669" } };

    Object.values(shopEarnings).forEach(se => {
      summarySheet.addRow({
        shopName: se.name,
        orderCount: se.orderCount,
        pageCost: se.pageCost.toFixed(2),
        baseFee: se.baseFee.toFixed(2),
        total: se.total.toFixed(2),
        platformEarnings: se.baseFee.toFixed(2), // Platform earns the base fee
      });
    });

    // Total row
    summarySheet.addRow({
      shopName: "TOTAL",
      orderCount: ordersSnap.size,
      pageCost: totalPageCosts.toFixed(2),
      baseFee: totalBaseFees.toFixed(2),
      total: totalRevenue.toFixed(2),
      platformEarnings: totalBaseFees.toFixed(2),
    });
    const lastRow = summarySheet.lastRow;
    if (lastRow) lastRow.font = { bold: true };

    // Write to buffer
    const buffer = await workbook.xlsx.writeBuffer();

    // Upload to Firebase Storage
    const reportFileName = `reports/earnings_${startDate.split("T")[0]}_to_${endDate.split("T")[0]}_${Date.now()}.xlsx`;
    const bucket = admin.storage().bucket();
    const file = bucket.file(reportFileName);
    await file.save(Buffer.from(buffer as ArrayBuffer), {
      metadata: {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        metadata: { generatedBy: request.auth.uid },
      },
    });

    // Generate signed download URL (valid for 7 days)
    const [url] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    // Save report metadata to Firestore
    const reportId = `report_${Date.now()}`;
    await db.collection("reports").doc(reportId).set({
      id: reportId,
      type: reportType || "full",
      startDate,
      endDate,
      totalOrders: ordersSnap.size,
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      totalBaseFees: parseFloat(totalBaseFees.toFixed(2)),
      totalPageCosts: parseFloat(totalPageCosts.toFixed(2)),
      storagePath: reportFileName,
      downloadUrl: url,
      generatedAt: new Date().toISOString(),
      generatedBy: request.auth.uid,
    });

    logger.info(`[generateEarningsReport] Report generated: ${reportFileName}, ${ordersSnap.size} orders, ₹${totalRevenue.toFixed(2)} revenue`);

    return {
      success: true,
      reportId,
      downloadUrl: url,
      totalOrders: ordersSnap.size,
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
    };
  }
);


// ---------- BUG 12: SERVER-SIDE NOTIFICATION TRIGGERS ----------

/**
 * onShopUpdated — Handles shop approval and archiving notifications
 */
export const onShopUpdated = onDocumentUpdated(
  { document: "shops/{shopId}", region: "asia-south1" },
  async (event) => {
    const beforeData = event.data?.before.data();
    const afterData = event.data?.after.data();
    if (!beforeData || !afterData) return;

    const shopId = event.params.shopId;
    const notifications = [];
    const timestamp = new Date().toISOString();

    if (!beforeData.isApproved && afterData.isApproved) {
      notifications.push({
        message: `Your shop "${afterData.name}" has been approved by the admin! You can now accept orders.`,
        type: "success",
        recipientUserId: afterData.ownerUserId,
        targetShopId: shopId,
        read: false,
        timestamp,
      });
    }

    if (!beforeData.isArchived && afterData.isArchived) {
      notifications.push({
        message: `Your shop "${afterData.name}" has been archived by the admin. It is no longer visible to students.`,
        type: "warning",
        recipientUserId: afterData.ownerUserId,
        targetShopId: shopId,
        read: false,
        timestamp,
      });
    }

    if (beforeData.isArchived && !afterData.isArchived) {
      notifications.push({
        message: `Your shop "${afterData.name}" has been restored by the admin. You can now accept orders again.`,
        type: "success",
        recipientUserId: afterData.ownerUserId,
        targetShopId: shopId,
        read: false,
        timestamp,
      });
    }

    if (notifications.length > 0) {
      const batch = db.batch();
      for (const notif of notifications) {
        const docRef = db.collection("notifications").doc();
        batch.set(docRef, notif);
      }
      await batch.commit();
    }
  }
);

/**
 * onPayoutCreated — Handles payout requests
 */
export const onPayoutCreated = onDocumentCreated(
  { document: "payouts/{payoutId}", region: "asia-south1" },
  async (event) => {
    const payoutData = event.data?.data();
    if (!payoutData) return;

    // Only notify if it's PENDING
    if (payoutData.status === "PENDING") {
      const adminsSnap = await db.collection("users").where("type", "==", "ADMIN").get();
      const batch = db.batch();

      for (const adminDoc of adminsSnap.docs) {
        const docRef = db.collection("notifications").doc();
        batch.set(docRef, {
          message: `${payoutData.shopName} has requested a payout of ₹${payoutData.amount.toFixed(2)}.`,
          type: "info",
          recipientUserId: adminDoc.id,
          read: false,
          timestamp: new Date().toISOString(),
        });
      }
      await batch.commit();
    }
  }
);

/**
 * onTicketCreated — Handles new ticket creation
 */
export const onTicketCreated = onDocumentCreated(
  { document: "tickets/{ticketId}", region: "asia-south1" },
  async (event) => {
    const ticketData = event.data?.data();
    if (!ticketData) return;

    await db.collection("notifications").add({
      message: `Ticket "${ticketData.subject}" submitted. We'll respond within 24 hours.`,
      type: "success",
      recipientUserId: ticketData.raisedBy,
      read: false,
      timestamp: new Date().toISOString(),
    });
  }
);

/**
 * onTicketStatusChangedNotify - explicitly separate from ticket status file cleanup
 */
export const onTicketStatusChangedNotify = onDocumentUpdated(
  { document: "tickets/{ticketId}", region: "asia-south1" },
  async (event) => {
    const beforeData = event.data?.before.data();
    const afterData = event.data?.after.data();
    if (!beforeData || !afterData) return;

    if (beforeData.status !== afterData.status) {
      await db.collection("notifications").add({
        message: `Ticket "${afterData.subject}" status changed to ${afterData.status.replace(/_/g, " ")}.`,
        type: "info",
        recipientUserId: afterData.raisedBy,
        read: false,
        timestamp: new Date().toISOString(),
      });
    }
  }
);

/**
 * onUserCreated — Handles welcome notifications
 */
export const onUserCreated = onDocumentCreated(
  { document: "users/{userId}", region: "asia-south1" },
  async (event) => {
    const userData = event.data?.data();
    if (!userData) return;

    const userId = event.params.userId;
    let message = "";
    if (userData.type === "STUDENT") {
      message = `Welcome, ${userData.name || "Student"}! Registration successful.`;
    } else if (userData.type === "SHOP_OWNER") {
      message = `Welcome, ${userData.name || "Shop Owner"}! Shop registered and is pending admin approval.`;
    }

    if (message) {
      await db.collection("notifications").add({
        message,
        type: "success",
        recipientUserId: userId,
        read: false,
        timestamp: new Date().toISOString(),
      });
    }
  }
);

/**
 * requestPayout — Secure Server-Side Payout Creation
 * Validates the amount requested against actual earned vs requested amounts.
 */
export const requestPayout = onCall(
  { region: "asia-south1" },
  async (request: any) => {
    const { data, auth } = request;
    if (!auth) {
      throw new HttpsError("unauthenticated", "You must be logged in to request a payout.");
    }

    const { shopId, amount, shopOwnerNote, requestId } = data;

    if (!shopId || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || !requestId) {
      throw new HttpsError("invalid-argument", "Missing or invalid payout details. A unique requestId and valid numeric amount are required.");
    }

    await enforceRateLimit({
      key: `payout_request_user:${auth.uid}`,
      maxRequests: 5,
      windowMs: 60 * 60 * 1000,
      actionLabel: "payout",
    });

    const preflightUserDoc = await db.collection("users").doc(auth.uid).get();
    if (!preflightUserDoc.exists || preflightUserDoc.data()?.type !== "SHOP_OWNER") {
      throw new HttpsError("permission-denied", "You do not have permission to request a payout.");
    }

    const preflightShopDoc = await db.collection("shops").doc(shopId).get();
    if (!preflightShopDoc.exists) {
      throw new HttpsError("not-found", "Shop not found.");
    }
    if (preflightShopDoc.data()?.ownerUserId !== auth.uid) {
      throw new HttpsError("permission-denied", "You are not the owner of this shop.");
    }
    if (preflightUserDoc.data()?.shopId !== shopId) {
      throw new HttpsError("permission-denied", "Shop association mismatch. Contact support.");
    }
    if (!preflightShopDoc.data()?.isApproved) {
      throw new HttpsError("failed-precondition", "Your shop must be approved before requesting a payout.");
    }

    await enforceRateLimit({
      key: `payout_request_shop:${shopId}`,
      maxRequests: 5,
      windowMs: 60 * 60 * 1000,
      actionLabel: "payout",
    });

    try {
      const result = await db.runTransaction(async (transaction) => {
        // 1. Authenticate user (defense-in-depth check only — not the primary auth source)
        const userRef = db.collection("users").doc(auth.uid);
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists || userDoc.data()?.type !== "SHOP_OWNER") {
          throw new HttpsError("permission-denied", "You do not have permission to request a payout.");
        }

        // 2. Lock the shop document — canonical primary authorization
        const shopRef = db.collection("shops").doc(shopId);
        const shopDoc = await transaction.get(shopRef);

        if (!shopDoc.exists) {
          throw new HttpsError("not-found", "Shop not found.");
        }
        // Canonical ownership check — do NOT rely solely on users.shopId which can be stale/poisoned
        if (shopDoc.data()?.ownerUserId !== auth.uid) {
          throw new HttpsError("permission-denied", "You are not the owner of this shop.");
        }
        // Defense-in-depth: userDoc.shopId should also match
        if (userDoc.data()?.shopId !== shopId) {
          throw new HttpsError("permission-denied", "Shop association mismatch. Contact support.");
        }
        // Business rule: only approved shops may withdraw
        if (!shopDoc.data()?.isApproved) {
          throw new HttpsError("failed-precondition", "Your shop must be approved before requesting a payout.");
        }

        const ledgerBalance = shopDoc.data()?.ledgerBalance || 0;

        // NEGATIVE BALANCE GUARD: Block payouts if balance is zero or negative
        if (ledgerBalance <= 0) {
          throw new HttpsError("failed-precondition",
            "Your balance is currently zero or negative due to pending refunds. Payouts are blocked until the balance is positive.");
        }
        if (amount > ledgerBalance) {
          throw new HttpsError("failed-precondition",
            `Requested amount (₹${amount}) exceeds currently available balance (₹${ledgerBalance.toFixed(2)}).`);
        }

        const now = new Date().toISOString();

        // 3. Check for double-spend using the provided requestId (Read before Write)
        const newPayoutRef = db.collection("payouts").doc(requestId);
        const existingPayout = await transaction.get(newPayoutRef);

        if (existingPayout.exists) {
          throw new HttpsError("already-exists", "A payout request with this ID has already been submitted.");
        }

        // 4. Gather payout order IDs (READ — must happen before any writes)
        const payoutOrderIds = await getPayoutOrderIdsForRequest(transaction, shopId, amount);

        // 5. Decrement ledger balance (WRITE)
        transaction.update(shopRef, {
          ledgerBalance: ledgerBalance - amount,
          financialVersion: admin.firestore.FieldValue.increment(1),
        });

        // 6. Create payout document (WRITE)
        transaction.set(newPayoutRef, {
          id: newPayoutRef.id,
          shopId,
          shopName: shopDoc.data()?.name || "Unknown Shop",
          amount,
          payoutOrderIds,
          shopOwnerNote: shopOwnerNote || "",
          status: "PENDING",
          createdAt: now
        });

        // 7. Create DEBIT ledger entry (WRITE — Deterministic doc ID for deduplication)
        const debitRef = db.collection("shopLedger").doc(`payout_${newPayoutRef.id}`);
        transaction.set(debitRef, {
          id: debitRef.id,
          eventId: `payout_${newPayoutRef.id}`,
          shopId,
          type: "PAYOUT",
          status: "SETTLED",
          amount: -amount,
          counterparty: "PLATFORM",
          description: `Payout withdrawal`,
          createdBy: "SHOP",
          createdAt: now,
        });
        return { payoutId: newPayoutRef.id };
      });

      logger.info("PAYOUT_CREATED", {
        event: "PAYOUT_CREATED",
        payoutId: result.payoutId,
        shopId,
        amount,
        timestamp: Date.now()
      });

      return {
        success: true,
        payoutId: result.payoutId,
        message: `Payout request of ₹${amount.toFixed(2)} submitted successfully.`
      };
    } catch (error: any) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("internal", error.message || "Failed to process payout.");
    }
  }
);

export const createSupportTicket = onCall(
  { region: "asia-south1", cors: true },
  async (request: any) => {
    const { auth, data } = request;
    if (!auth) {
      throw new HttpsError("unauthenticated", "You must be logged in to create a support ticket.");
    }

    // Rate limit: max 5 tickets per hour per user
    await enforceRateLimit({ key: `ticket_create_${auth.uid}`, maxRequests: 5, windowMs: 60 * 60 * 1000, actionLabel: "ticket creation" });

    const subject = typeof data?.subject === "string" ? data.subject.trim() : "";
    const description = typeof data?.description === "string" ? data.description.trim() : "";
    const category = typeof data?.category === "string" ? data.category : "";
    const relatedOrderId = typeof data?.relatedOrderId === "string" && data.relatedOrderId.trim()
      ? data.relatedOrderId.trim()
      : undefined;

    const validCategories = ["ORDER_ISSUE", "PAYMENT_ISSUE", "DELIVERY_ISSUE", "OTHER"];
    if (!subject || !description || !validCategories.includes(category)) {
      throw new HttpsError("invalid-argument", "Missing or invalid ticket details.");
    }

    const userDoc = await db.collection("users").doc(auth.uid).get();
    if (!userDoc.exists) {
      throw new HttpsError("not-found", "User profile not found.");
    }

    const userData = userDoc.data() || {};
    if (!["STUDENT", "SHOP_OWNER"].includes(userData.type)) {
      throw new HttpsError("permission-denied", "Only students and shop owners can create support tickets.");
    }

    let resolvedShopId: string | undefined;
    let resolvedShopName: string | undefined;

    if (userData.type === "SHOP_OWNER") {
      const ownerShopId = userData.shopId;
      if (!ownerShopId) {
        throw new HttpsError("failed-precondition", "Shop data is still loading. Please try again.");
      }

      const shopDoc = await db.collection("shops").doc(ownerShopId).get();
      if (!shopDoc.exists || shopDoc.data()?.ownerUserId !== auth.uid) {
        throw new HttpsError("permission-denied", "You are not the owner of this shop.");
      }

      resolvedShopId = ownerShopId;
      resolvedShopName = shopDoc.data()?.name || undefined;

      if (relatedOrderId) {
        const orderDoc = await db.collection("orders").doc(relatedOrderId).get();
        if (!orderDoc.exists) {
          throw new HttpsError("not-found", "Related order not found.");
        }
        if (orderDoc.data()?.shopId !== resolvedShopId) {
          throw new HttpsError("permission-denied", "You may only attach orders that belong to your own shop.");
        }
      }
    } else if (relatedOrderId) {
      const orderDoc = await db.collection("orders").doc(relatedOrderId).get();
      if (!orderDoc.exists) {
        throw new HttpsError("not-found", "Related order not found.");
      }
      if (orderDoc.data()?.userId !== auth.uid) {
        throw new HttpsError("permission-denied", "You may only attach your own orders.");
      }

      resolvedShopId = orderDoc.data()?.shopId || undefined;
      if (resolvedShopId) {
        const shopDoc = await db.collection("shops").doc(resolvedShopId).get();
        resolvedShopName = shopDoc.exists ? (shopDoc.data()?.name || undefined) : undefined;
      }
    }

    const now = new Date().toISOString();
    const ticketRef = db.collection("tickets").doc();
    const raisedByName = userData.name || auth.token.name || "Unknown";
    const raisedByEmail = userData.email || auth.token.email || "";

    await ticketRef.set({
      id: ticketRef.id,
      raisedBy: auth.uid,
      raisedByType: userData.type,
      raisedByName,
      raisedByEmail,
      ...(resolvedShopId ? { shopId: resolvedShopId } : {}),
      ...(resolvedShopName ? { shopName: resolvedShopName } : {}),
      ...(relatedOrderId ? { relatedOrderId } : {}),
      subject,
      category,
      description,
      status: "OPEN",
      messages: [{
        id: `msg_${Date.now()}`,
        senderId: auth.uid,
        senderName: raisedByName,
        senderType: userData.type,
        message: description,
        timestamp: now,
      }],
      statusHistory: [{
        from: "OPEN",
        to: "OPEN",
        changedBy: auth.uid,
        changedByName: raisedByName,
        timestamp: now,
        note: "Ticket created",
      }],
      createdAt: now,
      updatedAt: now,
    });

    return { success: true, ticketId: ticketRef.id };
  }
);

export const attachTicketFiles = onCall(
  { region: "asia-south1", cors: true },
  async (request: any) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in to attach files.");
    }

    const ticketId = typeof request.data?.ticketId === "string" ? request.data.ticketId.trim() : "";
    if (!ticketId) {
      throw new HttpsError("invalid-argument", "ticketId is required.");
    }

    const attachmentPaths = validateTicketAttachmentPaths(ticketId, request.data?.attachmentPaths);
    const ticketRef = db.collection("tickets").doc(ticketId);
    const ticketDoc = await ticketRef.get();

    if (!ticketDoc.exists) {
      throw new HttpsError("not-found", "Ticket not found.");
    }
    if (ticketDoc.data()?.raisedBy !== request.auth.uid) {
      throw new HttpsError("permission-denied", "You may only attach files to your own tickets.");
    }

    await ticketRef.update({
      attachmentPaths,
      updatedAt: new Date().toISOString(),
    });

    return { success: true };
  }
);

/**
 * adminCreatePayout — Secure Server-Side Manual Payout Creation
 * Handled by admins, enforces strict idempotency and ledger validation.
 */
export const adminCreatePayout = onCall(
  { region: "asia-south1" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in.");

    const callerDoc = await db.collection("users").doc(request.auth.uid).get();
    if (callerDoc.data()?.type !== "ADMIN") {
      throw new HttpsError("permission-denied", "Only admins can manually create payouts.");
    }

    const { shopId, amount, adminNote, idempotencyKey, otp } = request.data;
    if (!shopId || !amount || amount <= 0 || !idempotencyKey || !otp) {
      throw new HttpsError("invalid-argument", "Missing or invalid payout parameters, or OTP not provided.");
    }

    // Verify OTP explicitly before starting massive transactions
    await verifyAdminOTP(request.auth.uid, otp, "CREATE_MANUAL_PAYOUT");

    const payoutId = `payout_${idempotencyKey}`;

    try {
      await db.runTransaction(async (transaction) => {
        const payoutRef = db.collection("payouts").doc(payoutId);
        const existingPayout = await transaction.get(payoutRef);

        if (existingPayout.exists) {
          throw new HttpsError("already-exists", "Payout already processed.");
        }

        const shopRef = db.collection("shops").doc(shopId);
        const shopDoc = await transaction.get(shopRef);

        if (!shopDoc.exists) {
          throw new HttpsError("not-found", "Shop not found.");
        }

        const ledgerBalance = shopDoc.data()?.ledgerBalance || 0;
        if (amount > ledgerBalance) {
          throw new HttpsError("failed-precondition", `Insufficient ledger balance. Requested: ₹${amount}, Available: ₹${ledgerBalance}`);
        }

        const now = new Date().toISOString();

        transaction.update(shopRef, {
          ledgerBalance: ledgerBalance - amount,
          financialVersion: admin.firestore.FieldValue.increment(1),
        });

        transaction.set(payoutRef, {
          id: payoutId,
          shopId,
          shopName: shopDoc.data()?.name || "Unknown Shop",
          amount,
          adminNote: adminNote || "",
          status: "PAID",
          createdAt: now,
          paidAt: now
        });

        const debitRef = db.collection("shopLedger").doc(`manual_payout_${payoutId}`);
        transaction.set(debitRef, {
          id: debitRef.id,
          eventId: payoutId,
          shopId,
          type: "MANUAL_PAYOUT_DEDUCTION",
          status: "SETTLED",
          amount: -amount,
          counterparty: "PLATFORM",
          description: `Admin manual payout to shop`,
          createdBy: "ADMIN",
          createdAt: now,
        });
      });

      return { success: true, message: "Payout created and balance deducted.", payoutId };
    } catch (error: any) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("internal", error.message || "Failed to process manual payout.");
    }
  }
);

/**
 * cancelPayout — Admin reverses a manual payout, refunds the ledger.
 */
export const cancelPayout = onCall(
  { region: "asia-south1" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in.");

    const callerDoc = await db.collection("users").doc(request.auth.uid).get();
    if (callerDoc.data()?.type !== "ADMIN") {
      throw new HttpsError("permission-denied", "Only admins can cancel payouts.");
    }

    const { payoutId, otp } = request.data;
    if (!payoutId || !otp) throw new HttpsError("invalid-argument", "payoutId and otp are required.");

    // Enforce OTP logic for cancellations
    await verifyAdminOTP(request.auth.uid, otp, "CANCEL_PAYOUT");

    try {
      await db.runTransaction(async (transaction) => {
        const payoutRef = db.collection("payouts").doc(payoutId);
        const payoutDoc = await transaction.get(payoutRef);

        if (!payoutDoc.exists) throw new HttpsError("not-found", "Payout not found.");

        const payoutData = payoutDoc.data()!;
        // Security constraint: Only PENDING or DISPUTED payouts can be cancelled/reversed
        if (payoutData.status !== "PENDING" && payoutData.status !== "DISPUTED") {
          throw new HttpsError("failed-precondition", "Only PENDING or DISPUTED payouts can be cancelled. Confirmed payouts cannot be reversed.");
        }

        const shopRef = db.collection("shops").doc(payoutData.shopId);
        const shopDoc = await transaction.get(shopRef);
        const ledgerBalance = shopDoc.data()?.ledgerBalance || 0;

        const now = new Date().toISOString();
        const payoutAmountNumber = typeof payoutData.amount === "number" ? payoutData.amount : Number(payoutData.amount) || 0;

        transaction.update(shopRef, {
          ledgerBalance: ledgerBalance + payoutAmountNumber,
          financialVersion: admin.firestore.FieldValue.increment(1),
        });

        transaction.update(payoutRef, {
          status: "CANCELLED",
          cancelledAt: now,
          adminResolvedAt: now
        });

        const refundRef = db.collection("shopLedger").doc(`cancel_payout_${payoutId}`);
        transaction.set(refundRef, {
          id: refundRef.id,
          eventId: payoutId,
          shopId: payoutData.shopId,
          type: "PAYOUT_CANCEL_REFUND",
          status: "SETTLED",
          amount: payoutData.amount,
          counterparty: "PLATFORM",
          description: `Payout cancellation refund`,
          createdBy: "ADMIN",
          createdAt: now,
        });
      });

      return { success: true, message: "Payout cancelled successfully." };
    } catch (error: any) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("internal", error.message || "Failed to cancel payout.");
    }
  }
);

/**
 * approvePayoutRequest — Admin approves a PENDING payout request.
 * Sets the payout to PAID.
 */
export const approvePayoutRequest = onCall(
  { region: "asia-south1" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in.");

    const callerDoc = await db.collection("users").doc(request.auth.uid).get();
    if (callerDoc.data()?.type !== "ADMIN") {
      throw new HttpsError("permission-denied", "Only admins can approve payouts.");
    }

    const { payoutId, adminNote, otp } = request.data;
    if (!payoutId || !otp) throw new HttpsError("invalid-argument", "payoutId and otp are required.");

    await verifyAdminOTP(request.auth.uid, otp, "APPROVE_PAYOUT");

    try {
      await db.runTransaction(async (transaction) => {
        const payoutRef = db.collection("payouts").doc(payoutId);
        const payoutDoc = await transaction.get(payoutRef);

        if (!payoutDoc.exists) throw new HttpsError("not-found", "Payout not found.");

        const payoutData = payoutDoc.data()!;
        if (payoutData.status !== "PENDING") {
          throw new HttpsError("failed-precondition", "Only PENDING payouts can be approved.");
        }

        const now = new Date().toISOString();

        transaction.update(payoutRef, {
          status: "PAID",
          adminNote: adminNote || payoutData.adminNote || "",
          paidAt: now,
          adminResolvedAt: now
        });
      });

      return { success: true, message: "Payout approved." };
    } catch (error: any) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("internal", error.message || "Failed to approve payout.");
    }
  }
);

/**
 * rejectPayoutRequest — Admin rejects a PENDING payout request.
 * Re-credits the ledger because the initial request deducted it.
 */
export const rejectPayoutRequest = onCall(
  { region: "asia-south1" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in.");

    const callerDoc = await db.collection("users").doc(request.auth.uid).get();
    if (callerDoc.data()?.type !== "ADMIN") {
      throw new HttpsError("permission-denied", "Only admins can reject payouts.");
    }

    const { payoutId, adminNote, otp } = request.data;
    if (!payoutId || !otp) throw new HttpsError("invalid-argument", "payoutId and otp are required.");

    await verifyAdminOTP(request.auth.uid, otp, "REJECT_PAYOUT");

    try {
      await db.runTransaction(async (transaction) => {
        const payoutRef = db.collection("payouts").doc(payoutId);
        const payoutDoc = await transaction.get(payoutRef);

        if (!payoutDoc.exists) throw new HttpsError("not-found", "Payout not found.");

        const payoutData = payoutDoc.data()!;
        if (payoutData.status !== "PENDING") {
          throw new HttpsError("failed-precondition", "Only PENDING payouts can be rejected.");
        }

        const shopRef = db.collection("shops").doc(payoutData.shopId);
        const shopDoc = await transaction.get(shopRef);
        const ledgerBalance = shopDoc.data()?.ledgerBalance || 0;

        const now = new Date().toISOString();
        const payoutAmountNumber = typeof payoutData.amount === "number" ? payoutData.amount : Number(payoutData.amount) || 0;

        // Refund the ledger balance
        transaction.update(shopRef, {
          ledgerBalance: ledgerBalance + payoutAmountNumber,
          financialVersion: admin.firestore.FieldValue.increment(1),
        });

        transaction.update(payoutRef, {
          status: "REJECTED",
          adminNote: adminNote || payoutData.adminNote || "",
          rejectedAt: now,
          adminResolvedAt: now
        });

        const refundRef = db.collection("shopLedger").doc(`reject_payout_${payoutId}`);
        transaction.set(refundRef, {
          id: refundRef.id,
          eventId: payoutId,
          shopId: payoutData.shopId,
          type: "PAYOUT_REJECT_REFUND",
          status: "SETTLED",
          amount: payoutData.amount,
          counterparty: "PLATFORM",
          description: `Payout rejection refund`,
          createdBy: "ADMIN",
          createdAt: now,
        });
      });

      return { success: true, message: "Payout rejected and balance refunded." };
    } catch (error: any) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("internal", error.message || "Failed to reject payout.");
    }
  }
);

/**
 * confirmShopPayout — Shop owner confirms they have received the PAID payout.
 */
export const confirmShopPayout = onCall(
  { region: "asia-south1" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in.");

    const callerDoc = await db.collection("users").doc(request.auth.uid).get();
    if (callerDoc.data()?.type !== "SHOP_OWNER") {
      throw new HttpsError("permission-denied", "Only shop owners can confirm payouts.");
    }

    const { payoutId } = request.data;
    if (!payoutId) throw new HttpsError("invalid-argument", "payoutId is required.");

    const callerShopId = callerDoc.data()?.shopId;
    if (!callerShopId) throw new HttpsError("permission-denied", "Caller is not associated with a shop.");

    try {
      await db.runTransaction(async (transaction) => {
        const payoutRef = db.collection("payouts").doc(payoutId);
        const payoutDoc = await transaction.get(payoutRef);

        if (!payoutDoc.exists) throw new HttpsError("not-found", "Payout not found.");

        const payoutData = payoutDoc.data()!;

        // Canonical authorization: verify the payout's shopId has auth.uid as its owner
        const shopDoc = await transaction.get(db.collection("shops").doc(payoutData.shopId));
        if (!shopDoc.exists || shopDoc.data()?.ownerUserId !== request.auth!.uid) {
          throw new HttpsError("permission-denied", "You can only confirm payouts for your own shop.");
        }
        // Defense-in-depth: callerShopId must also match
        if (payoutData.shopId !== callerShopId) {
          throw new HttpsError("permission-denied", "Shop association mismatch.");
        }

        if (payoutData.status !== "PAID") {
          throw new HttpsError("failed-precondition", "Only PAID payouts can be confirmed.");
        }

        transaction.update(payoutRef, {
          status: "CONFIRMED",
          confirmedAt: new Date().toISOString()
        });
      });

      return { success: true, message: "Payout confirmed successfully." };
    } catch (error: any) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("internal", error.message || "Failed to confirm payout.");
    }
  }
);

/**
 * disputeShopPayout — Shop owner disputes a PAID payout if they haven't received it.
 */
export const disputeShopPayout = onCall(
  { region: "asia-south1" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in.");

    const callerDoc = await db.collection("users").doc(request.auth.uid).get();
    if (callerDoc.data()?.type !== "SHOP_OWNER") {
      throw new HttpsError("permission-denied", "Only shop owners can dispute payouts.");
    }

    const { payoutId, disputeNote } = request.data;
    if (!payoutId || !disputeNote || typeof disputeNote !== "string" || !disputeNote.trim()) {
      throw new HttpsError("invalid-argument", "payoutId and a valid disputeNote are required.");
    }

    const callerShopId = callerDoc.data()?.shopId;
    if (!callerShopId) throw new HttpsError("permission-denied", "Caller is not associated with a shop.");

    try {
      await db.runTransaction(async (transaction) => {
        const payoutRef = db.collection("payouts").doc(payoutId);
        const payoutDoc = await transaction.get(payoutRef);

        if (!payoutDoc.exists) throw new HttpsError("not-found", "Payout not found.");

        const payoutData = payoutDoc.data()!;

        // Canonical authorization: verify the payout's shopId has auth.uid as its owner
        const shopDoc = await transaction.get(db.collection("shops").doc(payoutData.shopId));
        if (!shopDoc.exists || shopDoc.data()?.ownerUserId !== request.auth!.uid) {
          throw new HttpsError("permission-denied", "You can only dispute payouts for your own shop.");
        }
        // Defense-in-depth: callerShopId must also match
        if (payoutData.shopId !== callerShopId) {
          throw new HttpsError("permission-denied", "Shop association mismatch.");
        }

        if (payoutData.status !== "PAID") {
          throw new HttpsError("failed-precondition", "Only PAID payouts can be disputed.");
        }

        transaction.update(payoutRef, {
          status: "DISPUTED",
          shopOwnerNote: disputeNote.trim(),
          disputedAt: new Date().toISOString()
        });
      });

      return { success: true, message: "Payout disputed successfully." };
    } catch (error: any) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("internal", error.message || "Failed to dispute payout.");
    }
  }
);

export * from "./backendResilience";
export * from "./refundLifecycle";

// --- Issue #22: Server-side shop approval callable ---
export const approveShopRegistration = onCall(
  { region: "asia-south1", cors: true },
  async (request: any) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Login required.");

    const adminDoc = await db.collection("users").doc(request.auth.uid).get();
    if (!adminDoc.exists || adminDoc.data()?.type !== "ADMIN") {
      throw new HttpsError("permission-denied", "Admin access required.");
    }

    const shopId = typeof request.data?.shopId === "string" ? request.data.shopId.trim() : "";
    if (!shopId) throw new HttpsError("invalid-argument", "shopId is required.");

    const shopRef = db.collection("shops").doc(shopId);
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) throw new HttpsError("not-found", "Shop not found.");
    const shopData = shopSnap.data()!;

    if (shopData.isApproved) {
      return { success: true, message: "Shop is already approved." };
    }

    await shopRef.update({ isApproved: true });

    // Server-side notification to shop owner
    await db.collection("notifications").add({
      message: `Your shop "${shopData.name}" has been approved! You can now accept orders.`,
      type: "success",
      recipientUserId: shopData.ownerUserId,
      targetShopId: shopId,
      read: false,
      timestamp: new Date().toISOString(),
    });

    // Audit
    await db.collection("accountActionAuditLog").add({
      action: "APPROVE_SHOP",
      adminUid: request.auth.uid,
      targetShopId: shopId,
      targetUid: shopData.ownerUserId,
      timestamp: new Date().toISOString(),
    });

    return { success: true, message: "Shop approved." };
  }
);

// --- Issue #3: Server-side shop rejection callable ---
export const rejectShopRegistration = onCall(
  { region: "asia-south1", cors: true },
  async (request: any) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Login required.");

    const adminDoc = await db.collection("users").doc(request.auth.uid).get();
    if (!adminDoc.exists || adminDoc.data()?.type !== "ADMIN") {
      throw new HttpsError("permission-denied", "Admin access required.");
    }

    const shopId = typeof request.data?.shopId === "string" ? request.data.shopId.trim() : "";
    if (!shopId) throw new HttpsError("invalid-argument", "shopId is required.");

    const shopRef = db.collection("shops").doc(shopId);
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) throw new HttpsError("not-found", "Shop not found.");
    const shopData = shopSnap.data()!;

    // Don't allow rejection of already-approved shops (use archive flow instead)
    if (shopData.isApproved) {
      throw new HttpsError("failed-precondition", "Cannot reject an already-approved shop. Use the archive flow instead.");
    }

    const ownerUserId = shopData.ownerUserId;
    const shopName = shopData.name || "Unknown Shop";

    // 1. Clean up private sub-collections
    const privateDocs = await db.collection("shops").doc(shopId).collection("private").get();
    const batch1 = db.batch();
    privateDocs.forEach((d) => batch1.delete(d.ref));
    await batch1.commit();

    const bankLogDocs = await db.collection("shops").doc(shopId).collection("bankAccessLogs").get();
    const batch2 = db.batch();
    bankLogDocs.forEach((d) => batch2.delete(d.ref));
    await batch2.commit();

    // 2. Delete shop doc
    await shopRef.delete();

    // 3. Delete user doc
    await db.collection("users").doc(ownerUserId).delete();

    // 4. Delete Firebase Auth account
    try {
      await admin.auth().deleteUser(ownerUserId);
    } catch (e: unknown) {
      if ((e as { code?: string }).code !== "auth/user-not-found") {
        logger.warn("[rejectShopRegistration] Auth delete failed:", e);
      }
    }

    // 5. Server-side notification (will be visible if they re-register)
    await db.collection("notifications").add({
      message: `Shop "${shopName}" registration was rejected by the admin.`,
      type: "warning",
      recipientUserId: ownerUserId,
      read: false,
      timestamp: new Date().toISOString(),
    });

    // 6. Audit log
    await db.collection("accountActionAuditLog").add({
      action: "REJECT_SHOP_REGISTRATION",
      adminUid: request.auth.uid,
      targetShopId: shopId,
      targetUid: ownerUserId,
      shopName,
      timestamp: new Date().toISOString(),
    });

    return { success: true, message: `Shop "${shopName}" rejected and cleaned up.` };
  }
);

// Refund lifecycle exports are already re-exported on line 3167 above.
