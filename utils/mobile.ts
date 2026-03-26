/**
 * Mobile platform utilities for Capacitor.
 * Handles status bar, splash screen, keyboard, and native file downloads.
 */
import { Capacitor } from '@capacitor/core';

/** Returns true when running inside a native iOS/Android shell */
export const isNative = () => Capacitor.isNativePlatform();

/** Returns 'ios' | 'android' | 'web' */
export const getPlatform = () => Capacitor.getPlatform();

/**
 * Initialize mobile-specific behavior.
 * Call once in your app entry point (e.g., App.tsx useEffect).
 */
export async function initMobile(): Promise<void> {
  if (!isNative()) return;

  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#0F172A' });

    if (getPlatform() === 'android') {
      await StatusBar.setOverlaysWebView({ overlay: false });
    }
  } catch (e) {
    console.warn('[Mobile] StatusBar plugin not available:', e);
  }

  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    // Hide splash after a short delay (the config auto-hides, but this is a safety net)
    setTimeout(() => SplashScreen.hide(), 2500);
  } catch (e) {
    console.warn('[Mobile] SplashScreen plugin not available:', e);
  }

  try {
    const { Keyboard } = await import('@capacitor/keyboard');
    // Prevent keyboard from pushing the viewport up on iOS
    if (getPlatform() === 'ios') {
      Keyboard.setAccessoryBarVisible({ isVisible: true });
    }
  } catch (e) {
    console.warn('[Mobile] Keyboard plugin not available:', e);
  }
}

/**
 * Download a file natively on mobile, or via blob URL on web.
 * On mobile, saves to the device's Downloads directory.
 */
export async function downloadFileNative(
  blob: Blob,
  fileName: string
): Promise<void> {
  if (!isNative()) {
    // Web fallback: use the existing blob URL approach
    downloadFileWeb(blob, fileName);
    return;
  }

  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');

    // Convert blob to base64
    const base64 = await blobToBase64(blob);

    await Filesystem.writeFile({
      path: fileName,
      data: base64,
      directory: Directory.Documents,
    });

    // Notify user
    console.log(`[Mobile] File saved: ${fileName}`);
  } catch (e) {
    console.error('[Mobile] Native download failed, falling back to web:', e);
    downloadFileWeb(blob, fileName);
  }
}

/** Standard web download via blob URL + anchor element */
function downloadFileWeb(blob: Blob, fileName: string): void {
  const blobUrl = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.style.display = 'none';
  document.body.appendChild(link);
  link.href = blobUrl;
  link.setAttribute('download', fileName);
  link.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
  );
  setTimeout(() => {
    document.body.removeChild(link);
    window.URL.revokeObjectURL(blobUrl);
  }, 300);
}

/** Convert a Blob to a base64 data string (without the data: prefix) */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Strip the "data:...;base64," prefix
      const base64 = result.split(',')[1] || result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
