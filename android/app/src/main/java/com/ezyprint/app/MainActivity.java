package com.ezyprint.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;

public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {

    /**
     * Channel IDs. These are duplicated in server/src/services/push.service.ts
     * (PushChannel) — a message whose channelId does not exist here is delivered
     * silently on Android 8+, with no error reported anywhere, so the two lists
     * must agree exactly.
     */
    private static final String CHANNEL_ORDERS = "ezyprint_orders";
    private static final String CHANNEL_TICKETS = "ezyprint_tickets";
    private static final String CHANNEL_ACCOUNT = "ezyprint_account";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createNotificationChannels();
    }

    @Override
    public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {
        // Required marker method for @capgo/capacitor-social-login to enable
        // native Google Sign-In with scopes & activity result forwarding.
    }

    /**
     * Channels are created here, natively, and nowhere else.
     *
     * Android ignores createNotificationChannel for an ID that already exists,
     * so whichever call runs first wins permanently and every later one is a
     * silent no-op. This activity runs before any web code, which is why the
     * JS-side channel creation that used to sit in utils/pushNotifications.ts
     * never applied a single one of its settings.
     *
     * Splitting by category is what makes the per-account behaviour work in
     * practice: a shop owner who does not want ticket chatter overnight can
     * mute tickets in system settings while new orders still ring through.
     */
    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        // A student is waiting at the counter — this one is allowed to interrupt.
        NotificationChannel orders = new NotificationChannel(
            CHANNEL_ORDERS,
            "Orders",
            NotificationManager.IMPORTANCE_HIGH
        );
        orders.setDescription("New print orders and order status updates.");
        orders.enableVibration(true);
        orders.enableLights(true);
        orders.setShowBadge(true);
        orders.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

        // Support replies matter but are not time-critical, so they arrive
        // without a heads-up banner.
        NotificationChannel tickets = new NotificationChannel(
            CHANNEL_TICKETS,
            "Support tickets",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        tickets.setDescription("Replies and status changes on your support tickets.");
        tickets.enableVibration(true);
        tickets.setShowBadge(true);

        // Payouts, earnings and account notices. A lockscreen preview of an
        // amount earned is a privacy leak on a shared or shoulder-surfed phone,
        // so this channel shows its content only once the device is unlocked.
        NotificationChannel account = new NotificationChannel(
            CHANNEL_ACCOUNT,
            "Payments & account",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        account.setDescription("Earnings, payouts, and account updates.");
        account.enableVibration(true);
        account.setShowBadge(true);
        account.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);

        manager.createNotificationChannel(orders);
        manager.createNotificationChannel(tickets);
        manager.createNotificationChannel(account);
    }
}
