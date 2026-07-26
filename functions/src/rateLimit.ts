import { HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

export async function enforceRateLimit(params: {
  key: string;
  maxRequests: number;
  windowMs: number;
  actionLabel: string;
}) {
  const { key, maxRequests, windowMs, actionLabel } = params;
  const nowMs = Date.now();
  const ref = db.collection("rateLimits").doc(key);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);

    if (!snap.exists) {
      tx.set(ref, {
        key,
        count: 1,
        windowStartedAtMs: nowMs,
        windowEndsAtMs: nowMs + windowMs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }

    const data = snap.data() || {};
    const windowStartedAtMs = data.windowStartedAtMs || 0;
    const currentCount = data.count || 0;

    if (nowMs - windowStartedAtMs >= windowMs) {
      tx.set(ref, {
        key,
        count: 1,
        windowStartedAtMs: nowMs,
        windowEndsAtMs: nowMs + windowMs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    if (currentCount >= maxRequests) {
      const retryAfterMs = Math.max(0, (data.windowEndsAtMs || (windowStartedAtMs + windowMs)) - nowMs);
      const retryAfterMinutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
      throw new HttpsError(
        "resource-exhausted",
        `Too many ${actionLabel} requests. Try again in ${retryAfterMinutes} minute(s).`
      );
    }

    tx.update(ref, {
      count: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
}
