import type { App } from 'firebase-admin/app';
import { prisma } from '../utils/prisma';
import { env } from '../config/env';

/**
 * Push transport (FCM).
 *
 * Firebase is used here as a message carrier and nothing else — no Firestore,
 * no Auth. It is the only way to wake an Android device that is not running the
 * app, which is why the dependency survives the migration off Firebase.
 *
 * Everything in this module fails soft. A push that does not send is a missed
 * buzz; the Notification row written alongside it is the durable record and is
 * still there when the user next opens the app. Nothing in an order, ticket or
 * payout flow may fail because Google was unreachable.
 */

/** Which Android channel a message lands in — see MainActivity.java. */
export type PushChannel = 'ezyprint_orders' | 'ezyprint_tickets' | 'ezyprint_account';

export interface PushMessage {
  title: string;
  body: string;
  channel: PushChannel;
  /** Values must be strings — FCM rejects a data payload with any other type. */
  data?: Record<string, string>;
}

/**
 * Lazily-initialised messaging handle.
 *
 * `undefined` = not yet attempted, `null` = attempted and unavailable. The
 * distinction keeps the "credentials missing" warning to a single line at first
 * use rather than once per notification.
 */
let messaging: import('firebase-admin/messaging').Messaging | null | undefined;

/** Parse the service account from raw JSON or base64. */
function parseServiceAccount(raw: string): Record<string, unknown> | null {
  const candidates = raw.trim().startsWith('{')
    ? [raw]
    : [Buffer.from(raw, 'base64').toString('utf8')];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // fall through to the null return below
    }
  }
  return null;
}

async function getMessaging() {
  if (messaging !== undefined) return messaging;

  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    if (env.isProd) {
      console.warn(
        '[push] FIREBASE_SERVICE_ACCOUNT is not set — devices will not receive push. ' +
        'In-app notifications are unaffected.'
      );
    }
    messaging = null;
    return messaging;
  }

  const serviceAccount = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT);
  if (!serviceAccount) {
    console.error('[push] FIREBASE_SERVICE_ACCOUNT is not valid JSON or base64 — push disabled.');
    messaging = null;
    return messaging;
  }

  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getMessaging: getMessagingFn } = await import('firebase-admin/messaging');

    // Reuse the app across hot reloads and across replicas of this module;
    // initializeApp throws on a duplicate name.
    const existing: App[] = getApps();
    const app = existing.length > 0
      ? existing[0]!
      : initializeApp({ credential: cert(serviceAccount as never) });

    messaging = getMessagingFn(app);
  } catch (error) {
    console.error('[push] failed to initialise FCM — push disabled:', error);
    messaging = null;
  }

  return messaging;
}

/**
 * Send a push to every device a user has registered.
 *
 * Tokens FCM reports as dead are removed. Without this the array grows without
 * bound — every reinstall and every app-data clear mints a new token and
 * abandons the old one — and each send would eventually spend most of its time
 * delivering to devices that no longer exist.
 */
export async function sendPushToUser(userId: string, message: PushMessage): Promise<void> {
  try {
    const fcm = await getMessaging();
    if (!fcm) return;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fcmTokens: true },
    });

    const tokens = user?.fcmTokens ?? [];
    if (tokens.length === 0) return;

    const response = await fcm.sendEachForMulticast({
      tokens,
      notification: { title: message.title, body: message.body },
      data: message.data,
      android: {
        priority: 'high',
        notification: {
          channelId: message.channel,
          // Collapsing on the entity means five status changes to one order
          // replace each other in the tray instead of stacking five deep.
          tag: message.data?.orderId ?? message.data?.ticketId,
        },
      },
    });

    const dead = response.responses.flatMap((result, index) => {
      if (result.success) return [];
      const code = result.error?.code;
      const isDead =
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token' ||
        code === 'messaging/invalid-argument';
      return isDead ? [tokens[index]!] : [];
    });

    if (dead.length > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: { fcmTokens: { set: tokens.filter((token) => !dead.includes(token)) } },
      });
    }
  } catch (error) {
    console.error(`[push] send to ${userId} failed:`, error);
  }
}

/** Register a device token, ignoring a token the user already has. */
export async function addPushToken(userId: string, token: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fcmTokens: true },
  });
  if (!user) return;
  if (user.fcmTokens.includes(token)) return;

  // A token identifies a device install, not a person. If someone else was
  // signed in on this device before, that account must stop receiving push for
  // it — otherwise logging out and handing over the phone keeps delivering the
  // previous owner's order and ticket updates to the new one. Only this token
  // is withdrawn from them; their other devices are left alone.
  const previousOwners = await prisma.user.findMany({
    where: { fcmTokens: { has: token }, id: { not: userId } },
    select: { id: true, fcmTokens: true },
  });

  await prisma.$transaction([
    ...previousOwners.map((owner) =>
      prisma.user.update({
        where: { id: owner.id },
        data: { fcmTokens: { set: owner.fcmTokens.filter((existing) => existing !== token) } },
      })
    ),
    prisma.user.update({
      where: { id: userId },
      // Cap the list so a user cycling through devices cannot grow it forever.
      data: { fcmTokens: { set: [...user.fcmTokens, token].slice(-10) } },
    }),
  ]);
}

/** Drop a device token, on logout. */
export async function removePushToken(userId: string, token: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fcmTokens: true },
  });
  if (!user) return;

  await prisma.user.update({
    where: { id: userId },
    data: { fcmTokens: { set: user.fcmTokens.filter((existing) => existing !== token) } },
  });
}
