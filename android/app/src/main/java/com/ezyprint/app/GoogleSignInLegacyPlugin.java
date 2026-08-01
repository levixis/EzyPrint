package com.ezyprint.app;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.tasks.Task;

/**
 * Google Sign-In through the account picker, not Credential Manager.
 *
 * The social-login plugin drives Google exclusively through AndroidX Credential
 * Manager, which only has a native implementation on API 34+. Below that it
 * runs on a Play Services shim, and on this project's target devices — mid-range
 * Android 10-13 handsets, which is most of a campus — that shim can display its
 * HiddenActivity and never call back at all. Not an error, not a cancellation:
 * the request simply never returns, so the app waits forever.
 *
 * This uses the older GoogleSignIn API instead. It shows the same system account
 * picker listing the accounts already on the phone, works from API 21 up, and
 * has no dependency on Credential Manager or on the vendor credential services
 * that were timing out underneath it.
 *
 * That API is deprecated in favour of Credential Manager and will eventually be
 * withdrawn. It is chosen deliberately: a deprecated call that returns beats a
 * current one that hangs, and switching back is a contained change once
 * Credential Manager is dependable on the devices these students actually own.
 *
 * `play-services-auth` is declared directly in app/build.gradle rather than
 * inherited from the social-login plugin, so removing that plugin cannot quietly
 * take sign-in with it.
 */
@CapacitorPlugin(name = "GoogleSignInLegacy")
public class GoogleSignInLegacyPlugin extends Plugin {

    private GoogleSignInClient client;

    private GoogleSignInClient clientFor(String webClientId) {
        GoogleSignInOptions options = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            // The web client id, not the Android one. Google audiences the
            // resulting id_token to whatever is named here, and the server
            // checks `aud` against GOOGLE_CLIENT_IDS — passing the Android
            // client id would produce a token our own backend rejects.
            .requestIdToken(webClientId)
            .requestEmail()
            .build();

        return GoogleSignIn.getClient(getActivity(), options);
    }

    @PluginMethod
    public void signIn(PluginCall call) {
        String webClientId = call.getString("webClientId");
        if (webClientId == null || webClientId.isEmpty()) {
            call.reject("webClientId is required");
            return;
        }

        try {
            client = clientFor(webClientId);
            startActivityForResult(call, client.getSignInIntent(), "handleSignInResult");
        } catch (Exception e) {
            call.reject("Could not start Google Sign-In: " + e.getMessage(), e);
        }
    }

    /**
     * Clears the cached account so the next sign-in offers the picker again.
     *
     * Without this the API silently reuses the last account, and a shared phone
     * — common where one handset serves a whole room — would keep signing in as
     * whoever used it first, with no way to choose.
     */
    @PluginMethod
    public void signOut(PluginCall call) {
        try {
            String webClientId = call.getString("webClientId", "");
            GoogleSignInClient c = (webClientId == null || webClientId.isEmpty())
                ? client
                : clientFor(webClientId);

            if (c == null) {
                call.resolve();
                return;
            }
            c.signOut().addOnCompleteListener(getActivity(), task -> call.resolve());
        } catch (Exception e) {
            // Signing out is best effort; failing it must not block a sign-in.
            call.resolve();
        }
    }

    @ActivityCallback
    private void handleSignInResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        try {
            Task<GoogleSignInAccount> task = GoogleSignIn.getSignedInAccountFromIntent(result.getData());
            GoogleSignInAccount account = task.getResult(ApiException.class);

            String idToken = account != null ? account.getIdToken() : null;
            if (idToken == null || idToken.isEmpty()) {
                // Reached when requestIdToken was given a client id Google does
                // not recognise for this app — the picker succeeds and the token
                // is quietly absent, which is worth naming rather than reporting
                // as a generic failure.
                call.reject("Google returned no id token. Check the web client id and the app's SHA-1 in Google Cloud Console.");
                return;
            }

            JSObject ret = new JSObject();
            ret.put("idToken", idToken);
            ret.put("email", account.getEmail());
            ret.put("name", account.getDisplayName());
            call.resolve(ret);
        } catch (ApiException e) {
            // 12501 is the user dismissing the picker; everything else is a real
            // fault and the status code is the only thing that identifies it.
            int code = e.getStatusCode();
            if (code == 12501) {
                call.reject("Sign-in cancelled", "CANCELLED");
            } else {
                call.reject("Google sign-in failed (status " + code + ")", String.valueOf(code), e);
            }
        } catch (Exception e) {
            call.reject("Google sign-in failed: " + e.getMessage(), e);
        }
    }
}
