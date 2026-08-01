/**
 * Push notification registration and handling for Capacitor native apps.
 * On web, this module is a no-op.
 */
import { Capacitor } from '@capacitor/core';
import * as api from '../lib/api';

let pushRegistered = false;

/**
 * The token this device most recently registered.
 *
 * Held so logout can withdraw the specific token rather than guessing. Without
 * it, signing out and handing the phone to someone else left the previous
 * account's orders and support replies buzzing on a device it no longer owned.
 */
let currentToken: string | null = null;

/** Listener handles, so logout can detach them individually. */
type PluginListener = { remove: () => Promise<void> };
let listeners: PluginListener[] = [];

/**
 * Incremented on every logout.
 *
 * Registration is asynchronous, so a user who signs out while it is still in
 * flight would otherwise have listeners attach after the teardown that was
 * meant to remove them. Signing back in would then attach a second set, and
 * every foreground notification would appear twice. Attaching code compares
 * this against the value it started with and discards its work if it lost.
 */
let registrationGeneration = 0;

const debugLog = (...args: unknown[]) => {
  void args;
};

/** What to do when a notification is tapped — set by the app on registration. */
export interface PushHandlers {
  /** A push arrived while the app was open and in the foreground. */
  onReceived?: (title: string, body: string, data?: Record<string, string>) => void;
  /** The user tapped a notification. Payload carries orderId or ticketId. */
  onTapped?: (data: Record<string, string>) => void;
}

/**
 * Register for push notifications on native platforms.
 * - Requests permission
 * - Gets the FCM device token
 * - Saves it to the user's record via the API
 * - Sets up listeners for incoming notifications
 *
 * Call this AFTER the user is authenticated — the token is stored against
 * whoever is signed in at the time.
 *
 * Android notification channels are NOT created here. They are created
 * natively in MainActivity.java, which runs first; Android ignores a channel
 * create for an ID that already exists, so anything configured from here would
 * be silently discarded.
 */
export async function registerPushNotifications(handlers?: PushHandlers): Promise<void> {
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
  pushRegistered = true;
  const generation = registrationGeneration;
  /** True once a logout has overtaken this registration. */
  const superseded = () => generation !== registrationGeneration;

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    // checkPermissions first: requestPermissions re-prompts only while the user
    // has not made a decision, and on Android 13+ a second request after a
    // denial returns 'denied' without showing anything.
    let permission = await PushNotifications.checkPermissions();
    if (permission.receive === 'prompt' || permission.receive === 'prompt-with-rationale') {
      permission = await PushNotifications.requestPermissions();
    }

    if (permission.receive !== 'granted') {
      debugLog('[Push] Permission not granted:', permission.receive);
      pushRegistered = false;
      return;
    }

    // The permission prompt can sit on screen indefinitely. If the user signed
    // out while it was up, everything below belongs to an account that is gone.
    if (superseded()) return;

    // Listeners must be attached before register(), or the registration event
    // can fire before anything is listening for it and the token is lost.
    const attached: PluginListener[] = [];

    attached.push(
      await PushNotifications.addListener('registration', async (token) => {
        if (superseded()) return;
        currentToken = token.value;
        try {
          await api.post('/users/me/push-token', { token: token.value });
          debugLog('[Push] Token saved via API');
        } catch (err) {
          // Leave pushRegistered true — the listener is live and a token
          // refresh will retry the save.
          debugLog('[Push] Failed to save token:', err);
        }
      })
    );

    attached.push(
      await PushNotifications.addListener('registrationError', (error) => {
        debugLog('[Push] Registration error:', error);
      })
    );

    attached.push(
      await PushNotifications.addListener('pushNotificationReceived', (notification) => {
        if (superseded()) return;
        handlers?.onReceived?.(
          notification.title || 'EzyPrint',
          notification.body || '',
          notification.data as Record<string, string> | undefined
        );
      })
    );

    attached.push(
      await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        if (superseded()) return;
        const data = (action.notification.data ?? {}) as Record<string, string>;
        handlers?.onTapped?.(data);
      })
    );

    // A logout that landed while the handles were being awaited has already run
    // its teardown against an empty list, so these have to be undone here or
    // they outlive the session and double every notification after re-login.
    if (superseded()) {
      await Promise.all(attached.map((listener) => listener.remove()));
      return;
    }
    listeners.push(...attached);

    // Register with the native push service (FCM on Android, APNs on iOS)
    await PushNotifications.register();
    debugLog('[Push] Registration complete');
  } catch (error) {
    pushRegistered = false;
    debugLog('[Push] Registration failed:', error);
  }
}

/**
 * Withdraw this device's token on logout.
 *
 * The server drops it from the user's record, so a signed-out account stops
 * receiving push here. Failure is tolerated — the token is also reclaimed
 * server-side the next time a different account registers it.
 */
export async function unregisterPushNotifications(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  const token = currentToken;
  currentToken = null;
  pushRegistered = false;
  // Anything still mid-registration is now stale and must not attach.
  registrationGeneration += 1;

  try {
    if (token) {
      await api.post('/users/me/push-token/remove', { token });
    }
  } catch (error) {
    debugLog('[Push] Failed to withdraw token:', error);
  }

  try {
    await Promise.all(listeners.map((listener) => listener.remove()));
  } catch (error) {
    debugLog('[Push] Failed to detach listeners:', error);
  } finally {
    listeners = [];
  }
}
