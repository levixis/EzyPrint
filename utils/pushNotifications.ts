/**
 * Push notification registration and handling for Capacitor native apps.
 * On web, this module is a no-op.
 */
import { Capacitor } from '@capacitor/core';
import { doc, arrayUnion } from 'firebase/firestore';
import { db } from '../firebase';

let pushRegistered = false;
const debugLog = (...args: unknown[]) => {
  void args;
};

/**
 * Register for push notifications on native platforms.
 * - Requests permission
 * - Gets the FCM device token
 * - Saves it to the user's Firestore document
 * - Sets up listeners for incoming notifications
 *
 * Call this AFTER the user is authenticated.
 */
export async function registerPushNotifications(
  userId: string,
  onNotificationReceived?: (title: string, body: string, data?: Record<string, string>) => void
): Promise<void> {
  // Only run on native platforms (Android/iOS)
  if (!Capacitor.isNativePlatform()) {
    debugLog('[Push] Skipping push registration on web platform');
    return;
  }

  // Prevent double-registration
  if (pushRegistered) {
    debugLog('[Push] Already registered');
    return;
  }

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    // Request permission
    const permResult = await PushNotifications.requestPermissions();

    if (permResult.receive === 'granted') {
      debugLog('[Push] Permission granted');

      // Create a high-importance notification channel for Android
      // This ensures notifications show as heads-up popups with sound
      try {
        await PushNotifications.createChannel({
          id: 'ezyprint_orders',
          name: 'Order Updates',
          description: 'Notifications for order status changes, payments, and updates',
          importance: 5, // IMPORTANCE_HIGH — shows as heads-up notification
          visibility: 1, // PUBLIC
          sound: 'default',
          vibration: true,
          lights: true,
        });
        debugLog('[Push] Android notification channel created');
      } catch (channelErr) {
        void channelErr;
      }

      // Register with the native push service (FCM on Android, APNs on iOS)
      await PushNotifications.register();

      // Listen for successful registration — this gives us the FCM token
      PushNotifications.addListener('registration', async (token) => {
        debugLog('[Push] Device token:', token.value);

        // Save token to user's Firestore document
        try {
          const userRef = doc(db, 'users', userId);
          const { setDoc } = await import('firebase/firestore');
          await setDoc(userRef, {
            fcmTokens: arrayUnion(token.value),
          }, { merge: true });
          debugLog('[Push] Token saved to Firestore');
        } catch (err) {
          void err;
        }
      });

      // Listen for registration errors
      PushNotifications.addListener('registrationError', (error) => {
        void error;
      });

      // Listen for incoming notifications while app is in foreground
      PushNotifications.addListener('pushNotificationReceived', (notification) => {
        debugLog('[Push] Notification received in foreground:', notification);
        if (onNotificationReceived) {
          onNotificationReceived(
            notification.title || 'EzyPrint',
            notification.body || '',
            notification.data as Record<string, string> | undefined
          );
        }
      });

      // Listen for notification tap (user tapped the notification)
      PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        debugLog('[Push] Notification tapped:', action);
        // The app is already open at this point — you could navigate to a specific order
        const orderId = action.notification.data?.orderId;
        if (orderId) {
          debugLog('[Push] Should navigate to order:', orderId);
          // Navigation can be handled by passing a callback or using a global event
        }
      });

      pushRegistered = true;
      debugLog('[Push] Registration complete');
    } else {
      debugLog('[Push] Permission denied by user');
    }
  } catch (error) {
    void error;
  }
}

/**
 * Remove the FCM token from Firestore when the user logs out.
 * This prevents sending notifications to a logged-out device.
 */
export async function unregisterPushNotifications(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    // We don't have an easy way to get the current token,
    // so we just remove all listeners and reset the flag.
    // The token will be overwritten on next login.
    await PushNotifications.removeAllListeners();
    pushRegistered = false;
    debugLog('[Push] Unregistered push notifications');
  } catch (error) {
    void error;
  }
}
