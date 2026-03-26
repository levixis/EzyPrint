import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.ezyprint.app',
  appName: 'EzyPrint',
  webDir: 'dist',
  server: {
    // Allow navigation to external URLs (Razorpay checkout, etc.)
    allowNavigation: ['*.razorpay.com'],
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 2000,
      backgroundColor: '#0F172A',
      showSpinner: true,
      spinnerColor: '#6366F1',
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0F172A',
    },
    Keyboard: {
      resize: 'native' as any,
      resizeOnFullScreen: true,
    },
  },
};

export default config;
