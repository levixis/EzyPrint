import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentUpdated, onDocumentCreated, onDocumentDeleted } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import Razorpay from "razorpay";
import * as crypto from "crypto";
import * as nodemailer from "nodemailer";

admin.initializeApp();
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
      console.log(`[FCM] No FCM tokens for user ${userId.slice(-6)}, skipping push`);
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

    // Send to all registered devices
    const invalidTokens: string[] = [];
    for (const token of tokens) {
      try {
        await admin.messaging().send({ ...message, token });
        console.log(`[FCM] Push sent to token ${token.slice(-8)} for user ${userId.slice(-6)}`);
      } catch (err: any) {
        // Token is invalid or expired — mark for cleanup
        if (
          err.code === "messaging/invalid-registration-token" ||
          err.code === "messaging/registration-token-not-registered"
        ) {
          invalidTokens.push(token);
          console.warn(`[FCM] Invalid token ${token.slice(-8)}, will remove`);
        } else {
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
  } catch (error: any) {
    console.error(`[FCM] Failed to send push to user ${userId.slice(-6)}:`, error.message);
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
    console.error(`[FCM] Failed to send push to shop ${shopId}:`, error.message);
  }
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

// ---------- Cloud Functions ----------

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

    // Fetch order from Firestore
    const orderDoc = await db.collection("orders").doc(orderId).get();
    if (!orderDoc.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }

    const orderData = orderDoc.data()!;

    // Verify the order belongs to this user
    if (orderData.userId !== request.auth.uid) {
      throw new HttpsError(
        "permission-denied",
        "You can only pay for your own orders."
      );
    }

    // Verify order is in a payable status (initial payment or retry)
    if (orderData.status !== "PENDING_PAYMENT" && orderData.status !== "PAYMENT_FAILED") {
      throw new HttpsError(
        "failed-precondition",
        `Order is not awaiting payment. Current status: ${orderData.status}`
      );
    }

    // Fetch shop pricing from Firestore
    const shopDoc = await db.collection("shops").doc(orderData.shopId).get();
    if (!shopDoc.exists) {
      throw new HttpsError("not-found", "Shop not found.");
    }

    const shopData = shopDoc.data()!;

    // Fetch user data to check student pass (with 30-day expiry check)
    const userDoc = await db
      .collection("users")
      .doc(request.auth.uid)
      .get();
    let hasStudentPass = false;
    if (userDoc.exists) {
      const userData = userDoc.data()!;
      if (userData.hasStudentPass === true && userData.studentPassActivatedAt) {
        const activatedAt = new Date(userData.studentPassActivatedAt).getTime();
        const expiryDate = activatedAt + 30 * 24 * 60 * 60 * 1000; // 30 days
        hasStudentPass = Date.now() < expiryDate;
        // Auto-expire in DB if past 30 days
        if (!hasStudentPass) {
          await db.collection("users").doc(request.auth.uid).update({ hasStudentPass: false });
        }
      }
    }

    // Recalculate price server-side
    // Use multi-file pricing if files[] array exists, else fall back to legacy
    let verifiedPrice: { pageCost: number; baseFee: number; totalPrice: number };
    const filesArray = orderData.files as OrderFileData[] | undefined;

    // SERVER-SIDE HEURISTICS: Prevent Page Count Forgery (Bug 2)
    if (filesArray && filesArray.length > 0) {
      for (const file of filesArray) {
        // Hard cap
        if (file.pageCount > 300) {
          throw new HttpsError("out-of-range", `File "${file.fileName}" exceeds the 300 page limit.`);
        }
        // Size-to-Page Heuristic: An extremely blank PDF page is still ~400 bytes.
        // E.g. a 10KB file (10,240 bytes) could hold at most ~25 blank pages. 
        // If they bypass this by spoofing fileSizeBytes, the 300 page cap and the human shopkeeper act as backups.
        if (file.fileSizeBytes && file.pageCount > 5) {
          const estimatedMinBytesPerPage = 350;
          const maxPossiblePages = Math.floor(file.fileSizeBytes / estimatedMinBytesPerPage);
          if (file.pageCount > maxPossiblePages) {
            console.warn(`[createOrder] Forgery caught: ${file.fileName} is ${file.fileSizeBytes}B but claims ${file.pageCount} pages.`);
            throw new HttpsError("invalid-argument", `File "${file.fileName}" claims too many pages (${file.pageCount}) for its physical size.`);
          }
        }
      }

      verifiedPrice = calculateMultiFilePrice(
        filesArray,
        shopData.customPricing as ShopPricing,
        hasStudentPass
      );
    } else {
      const printOpts = orderData.printOptions as PrintOptions;
      if (printOpts.pages > 300) {
        throw new HttpsError("out-of-range", "Total pages exceed the 300 limit.");
      }
      verifiedPrice = calculateOrderPrice(
        printOpts,
        shopData.customPricing as ShopPricing,
        hasStudentPass
      );
    }

    const amountInPaise = Math.round(verifiedPrice.totalPrice * 100);

    if (amountInPaise <= 0) {
      throw new HttpsError(
        "failed-precondition",
        "Order amount must be greater than zero."
      );
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

    // Verify signature using HMAC SHA256
    const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
    const generatedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      console.warn(`[verifyPayment] Signature mismatch for order ${orderId}. Falling back to Razorpay API check...`);

      // SAFETY NET: Check the payment status directly via Razorpay API.
      // This handles cases where the key was rotated or there's a mismatch.
      try {
        const payment = await getRazorpay().payments.fetch(razorpay_payment_id);
        if (payment.status === "captured" || payment.status === "authorized") {
          console.log(`[verifyPayment] Razorpay API confirms payment ${razorpay_payment_id} is ${payment.status}. Recovering order.`);
          await db.collection("orders").doc(orderId).update({
            status: "PENDING_APPROVAL",
            razorpayPaymentId: razorpay_payment_id,
            paymentAttemptedAt: new Date().toISOString(),
            paymentVerifiedVia: "api_fallback",
          });
          return { success: true, message: "Payment verified via Razorpay API." };
        } else {
          console.log(`[verifyPayment] Razorpay API says payment ${razorpay_payment_id} status is: ${payment.status}`);
        }
      } catch (apiError: any) {
        console.error(`[verifyPayment] Razorpay API fallback failed:`, apiError.message);
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
    if (orderData.razorpayOrderId !== razorpay_order_id) {
      throw new HttpsError(
        "permission-denied",
        "Payment verification failed. Razorpay Order ID mismatch."
      );
    }

    // Signature is valid — update order
    await db.collection("orders").doc(orderId).update({
      status: "PENDING_APPROVAL",
      razorpayPaymentId: razorpay_payment_id,
      paymentAttemptedAt: new Date().toISOString(),
    });

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
        console.log(`[checkPaymentStatus] Order ${orderId} has a captured payment: ${successfulPayment.id}`);

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
      console.error(`[checkPaymentStatus] Error checking payment:`, error.message);
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

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
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
        subject: `Verification Code: ${otp} (EzyPrint Refund)`,
        html: emailHtml,
      });
      return { success: true, message: `OTP sent successfully to ${adminEmail}` };
    } catch (error: any) {
      console.error("[requestRefundOTP] Failed to send email:", error);
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

    // Issue refund via Razorpay
    try {
      const refund = await getRazorpay().payments.refund(orderData.razorpayPaymentId, {
        speed: "normal", // "normal" for 5-7 day refund
        notes: {
          orderId: orderId,
          reason: reason || "Admin-initiated refund",
          initiatedBy: request.auth.uid,
        },
      });

      // Record refund details on the order document
      await db.collection("orders").doc(orderId).update({
        refundId: refund.id,
        refundStatus: refund.status, // "processed" or "pending"
        refundAmount: (refund.amount || 0) / 100, // Convert paise to rupees
        refundedAt: new Date().toISOString(),
        refundInitiatedBy: request.auth.uid,
        refundReason: reason || "Admin-initiated refund",
      });

      console.log(`[initiateRefund] Admin ${request.auth.uid} issued refund ${refund.id} for order #${orderId.slice(-6)}. Status: ${refund.status}, Amount: ₹${((refund.amount || 0) / 100).toFixed(2)}`);

      // Write to refund audit log
      const ip = request.rawRequest?.ip || request.rawRequest?.headers['x-forwarded-for'] || "unknown";
      try {
        await db.collection("refundAuditLog").add({
          adminUid: request.auth.uid,
          orderId: orderId,
          amount: (refund.amount || 0) / 100,
          timestamp: new Date().toISOString(),
          ipAddress: ip,
          reason: reason || "Admin-initiated refund"
        });
      } catch (logErr: any) {
        console.warn("[initiateRefund] Failed to write to audit log:", logErr);
      }

      // Notify the student
      try {
        await db.collection("notifications").add({
          message: `Refund of ₹${((refund.amount || 0) / 100).toFixed(2)} has been initiated for order #${orderId.slice(-6)}. Reason: ${reason || "Admin review"}. It will be credited within 5-7 business days.`,
          type: "info",
          recipientUserId: orderData.userId,
          orderId: orderId,
          read: false,
          timestamp: new Date().toISOString(),
        });
      } catch (notifError: any) {
        console.warn(`[initiateRefund] Failed to create student notification:`, notifError.message);
      }

      return {
        success: true,
        refundId: refund.id,
        refundStatus: refund.status,
        refundAmount: (refund.amount || 0) / 100,
        message: `Refund of ₹${((refund.amount || 0) / 100).toFixed(2)} initiated successfully.`,
      };
    } catch (refundError: any) {
      console.error(`[initiateRefund] REFUND FAILED for order #${orderId.slice(-6)}, payment ${orderData.razorpayPaymentId}:`, refundError.message);

      // Record the failure
      await db.collection("orders").doc(orderId).update({
        refundStatus: "FAILED",
        refundError: refundError.message || "Unknown refund error",
        refundedAt: new Date().toISOString(),
        refundInitiatedBy: request.auth.uid,
      });

      throw new HttpsError(
        "internal",
        `Refund failed: ${refundError.message || "Unknown error"}. The order has been flagged for manual intervention.`
      );
    }
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
    } catch (apiError: any) {
      console.error(`[verifyPassPayment] Razorpay API verification failed:`, apiError.message);
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
        await sendPushToUser(
          afterData.userId,
          "Order Complete ✅",
          `Order #${orderShortId} (${fileName}) has been completed. Thank you!`,
          { orderId, type: "order_status" }
        );
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
      console.error(`[onOrderStatusChange] Push notification error:`, pushError.message);
    }

    // --- AUTO-REFUND & FILE CLEANUP: Only for COMPLETED or CANCELLED ---
    if (newStatus !== "COMPLETED" && newStatus !== "CANCELLED") return;

    // --- AUTO-REFUND: Issue Razorpay refund when a PAID order is CANCELLED ---
    // Only refund if the order was actually paid (had reached PENDING_APPROVAL or beyond)
    // PAYMENT_FAILED orders may have a razorpayPaymentId from a failed attempt that was never captured
    const PAID_STATUSES = ["PENDING_APPROVAL", "PRINTING", "READY_FOR_PICKUP", "COMPLETED"];
    const wasTrulyPaid = afterData.razorpayPaymentId && PAID_STATUSES.includes(oldStatus);
    if (newStatus === "CANCELLED" && wasTrulyPaid) {
      console.log(`[onOrderStatusChange] Order #${orderId.slice(-6)} cancelled (was ${oldStatus}) with payment ${afterData.razorpayPaymentId}. Initiating automatic refund...`);

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
        } catch (notifError: any) {
          console.warn(`[onOrderStatusChange] Failed to create refund notification:`, notifError.message);
        }
      } catch (refundError: any) {
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
            recipientUserId: afterData.userId, // Notify the student so they can contact support
            read: false,
            timestamp: new Date().toISOString(),
          });
        } catch (notifError: any) {
          console.warn(`[onOrderStatusChange] Failed to create admin refund-failure notification:`, notifError.message);
        }
      }
    }

    // --- FILE CLEANUP: Delete uploaded files from Storage ---
    const bucket = admin.storage().bucket();
    const filesArray = afterData.files as OrderFileData[] | undefined;

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
          } catch (error: any) {
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
    } else {
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
        } catch (error: any) {
          console.error(`[onOrderStatusChange] Failed to delete file for order ${orderId}:`, error.message);
        }
      } else {
        console.log(`[onOrderStatusChange] No file to clean up for order ${orderId}`);
      }
    }
  }
);

/**
 * cleanupAbandonedOrders — Scheduled CRON job that runs every hour.
 * Scans for orders stuck in PENDING_PAYMENT for more than 2 hours,
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
          const filesArr = orderData.files as OrderFileData[] | undefined;
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
          } else {
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
        } catch (orderError: any) {
          errorCount++;
          console.error(`[cleanupAbandonedOrders] Error processing order ${orderId}:`, orderError.message);
        }
      }

      console.log(`[cleanupAbandonedOrders] Cleanup complete. Cancelled: ${deletedCount}, Errors: ${errorCount}`);
    } catch (error: any) {
      console.error("[cleanupAbandonedOrders] Fatal error during cleanup:", error.message);
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

    // Notify the shopkeeper about the new order
    try {
      await sendPushToShop(
        orderData.shopId,
        "New Order Received! 📄",
        `Order #${orderShortId} (${fileLabel}) — ₹${totalPrice}. Awaiting payment.`,
        { orderId, type: "new_order" }
      );

      // Bug 12: DB notifications
      await db.collection("notifications").add({
        message: `Order #${orderShortId} for ${fileLabel} (₹${totalPrice}) placed. Proceed to payment.`,
        type: "info",
        orderId,
        recipientUserId: orderData.userId,
        read: false,
        timestamp: new Date().toISOString(),
      });

    } catch (error: any) {
      console.error(`[onNewOrder] Push notification error:`, error.message);
    }
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

    console.log(`[cleanupOldNotifications] Running. Read cutoff: ${twoDaysAgo}, Unread cutoff: ${thirtyDaysAgo}`);

    let totalDeleted = 0;

    try {
      // 1. Delete READ notifications older than 2 days
      const readQuery = await db
        .collection("notifications")
        .where("read", "==", true)
        .where("timestamp", "<", twoDaysAgo)
        .limit(500)
        .get();

      if (!readQuery.empty) {
        const batch = db.batch();
        readQuery.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        totalDeleted += readQuery.size;
        console.log(`[cleanupOldNotifications] Deleted ${readQuery.size} read notifications (>2 days old)`);
      }

      // 2. Delete ALL notifications older than 30 days (safety cleanup)
      const oldQuery = await db
        .collection("notifications")
        .where("timestamp", "<", thirtyDaysAgo)
        .limit(500)
        .get();

      if (!oldQuery.empty) {
        const batch = db.batch();
        oldQuery.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        totalDeleted += oldQuery.size;
        console.log(`[cleanupOldNotifications] Deleted ${oldQuery.size} old notifications (>30 days)`);
      }

      console.log(`[cleanupOldNotifications] Cleanup complete. Total deleted: ${totalDeleted}`);
    } catch (error: any) {
      console.error("[cleanupOldNotifications] Error:", error.message);
    }
  }
);

/**
 * onUserDeleted — Firestore trigger that fires when a user document is deleted.
 * Cleans up all notifications for the deleted user.
 * This handles both admin deletion and self-deletion automatically.
 */
export const onUserDeleted = onDocumentDeleted(
  { document: "users/{userId}", region: "asia-south1" },
  async (event) => {
    const userId = event.params.userId;
    console.log(`[onUserDeleted] User ${userId.slice(-6)} deleted. Cleaning up notifications...`);

    try {
      // Delete all notifications for this user
      const notifsQuery = await db
        .collection("notifications")
        .where("recipientUserId", "==", userId)
        .get();

      if (notifsQuery.empty) {
        console.log(`[onUserDeleted] No notifications to clean up for user ${userId.slice(-6)}`);
        return;
      }

      const batch = db.batch();
      notifsQuery.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      console.log(`[onUserDeleted] Deleted ${notifsQuery.size} notification(s) for user ${userId.slice(-6)}`);
    } catch (error: any) {
      console.error(`[onUserDeleted] Error cleaning up notifications for ${userId.slice(-6)}:`, error.message);
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
      console.log(`[onTicketStatusChange] Ticket ${ticketId} has no attachments to clean up.`);
      return;
    }

    const bucket = admin.storage().bucket();
    let deletedCount = 0;

    for (const filePath of attachmentPaths) {
      try {
        const storageFile = bucket.file(filePath);
        const [exists] = await storageFile.exists();
        if (exists) {
          await storageFile.delete();
          deletedCount++;
          console.log(`[onTicketStatusChange] Deleted ticket attachment: ${filePath}`);
        }
      } catch (error: any) {
        console.error(`[onTicketStatusChange] Failed to delete attachment ${filePath}:`, error.message);
      }
    }

    // Clear attachment paths from the ticket document
    await db.collection("tickets").doc(ticketId).update({
      attachmentPaths: [],
      attachmentsCleanedAt: new Date().toISOString(),
    });

    console.log(`[onTicketStatusChange] Cleaned up ${deletedCount} attachment(s) for ticket ${ticketId}`);
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
    console.log(`[cleanupOldTickets] Running. Cutoff: ${ninetyDaysAgo}`);

    let totalDeleted = 0;

    try {
      for (const closedStatus of ["RESOLVED", "CLOSED"]) {
        const snapshot = await db
          .collection("tickets")
          .where("status", "==", closedStatus)
          .where("updatedAt", "<", ninetyDaysAgo)
          .limit(500)
          .get();

        if (!snapshot.empty) {
          const batch = db.batch();
          snapshot.docs.forEach((doc) => batch.delete(doc.ref));
          await batch.commit();
          totalDeleted += snapshot.size;
        }
      }
      console.log(`[cleanupOldTickets] Deleted ${totalDeleted} old ticket(s).`);
    } catch (error: any) {
      console.error(`[cleanupOldTickets] Error:`, error.message);
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

    console.log(`[generateEarningsReport] Generating ${reportType || 'full'} report: ${startDate} to ${endDate}`);

    // Fetch completed orders in the date range
    const ordersSnap = await db.collection("orders")
      .where("status", "==", "COMPLETED")
      .where("uploadedAt", ">=", startDate)
      .where("uploadedAt", "<=", endDate)
      .get();

    // Fetch all shops for name mapping
    const shopsSnap = await db.collection("shops").get();
    const shopMap: Record<string, string> = {};
    shopsSnap.docs.forEach(doc => {
      shopMap[doc.id] = doc.data().name || "Unknown Shop";
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
      const shopName = shopMap[d.shopId] || "Unknown";

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
        date: new Date(d.uploadedAt).toLocaleDateString("en-IN"),
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

    console.log(`[generateEarningsReport] Report generated: ${reportFileName}, ${ordersSnap.size} orders, ₹${totalRevenue.toFixed(2)} revenue`);

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
