import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { dismissTopOverlay } from './backGesture';
import { AppView } from '../types';

/**
 * Bridge Android's back gesture to the app's navigation.
 *
 * Registered exactly once for the lifetime of the mount. An earlier version
 * keyed the effect on currentView, so every navigation tore the listener down
 * and built a new one — and because the removal function was assigned two
 * promises deep (dynamic import, then addListener), a navigation that landed
 * before those resolved ran a cleanup that had nothing to clean up and leaked
 * the listener. Capacitor notifies every registered listener, so each survivor
 * fired with the view it had captured: one press would navigate back on the
 * live listener and minimise the app on a stale one.
 *
 * Everything that changes between renders is therefore read through a ref, and
 * the dependency array is empty rather than merely stable-in-practice.
 */

/** Views with nowhere left to go back to — the gesture leaves the app here. */
const ROOT_VIEWS: AppView[] = ['landing', 'login', 'studentDashboard', 'shopDashboard', 'adminDashboard'];

export function useAndroidBackButton(currentView: AppView, goBack: () => boolean): void {
  const currentViewRef = useRef(currentView);
  const goBackRef = useRef(goBack);

  useEffect(() => {
    currentViewRef.current = currentView;
    goBackRef.current = goBack;
  });

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let cleanup: (() => void) | undefined;
    let cancelled = false;

    import('@capacitor/app').then(({ App }) => {
      App.addListener('backButton', () => {
        // An open overlay owns the gesture. Closing the notification panel or a
        // modal is what the user means by "back" while one is on screen —
        // navigating underneath it instead left the overlay floating over a
        // view it had nothing to do with.
        if (dismissTopOverlay()) return;

        if (ROOT_VIEWS.includes(currentViewRef.current)) {
          App.minimizeApp();
          return;
        }

        // goBack is a no-op on an empty history, which on a non-root view left
        // the gesture doing nothing at all and the app feeling frozen. Falling
        // back to minimize matches what Android does everywhere else.
        if (!goBackRef.current()) App.minimizeApp();
      }).then(handle => {
        // Unmounted while the listener was still being attached — the cleanup
        // below has already run and will not run again, so remove it here.
        if (cancelled) {
          handle.remove();
          return;
        }
        cleanup = () => handle.remove();
      });
    }).catch(err => {
      void err;
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);
}
