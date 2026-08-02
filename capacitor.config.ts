import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.ezyprint.app',
  appName: 'EzyPrint',
  webDir: 'dist',
  server: {
    // Allow navigation to external URLs (Google auth, Razorpay checkout, etc.)
    // Sign-in goes through Google Identity Services directly, not Firebase Auth,
    // so only the accounts.google.com / googleapis.com hosts are needed here.
    allowNavigation: [
      '*.razorpay.com',
      '*.google.com',
      '*.googleapis.com',
      'accounts.google.com',
    ],
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resize: 'none' as any,
      resizeOnFullScreen: false,
    },
    SocialLogin: {
      google: {
        webClientId: '283831997162-p8afki1sjtfa9srdvr6infpf06gofmk5.apps.googleusercontent.com',
      },
    },
  },
};

export default config;
