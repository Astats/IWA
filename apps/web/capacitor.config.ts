import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native shells for Android and iOS (BUILD_PLAN 4.1, AD2). The WebView loads the built PWA from
 * `dist/`; nothing is fetched from a remote server.
 */
const config: CapacitorConfig = {
  appId: 'com.astats.budget',
  appName: 'Budget',
  webDir: 'dist',
  // Native logs (incl. forwarded console output) only in debug builds, never in release (SEC-M02).
  loggingBehavior: 'debug',
  server: {
    // Secure context (Web Crypto, OPFS) at https://localhost; iOS keeps capacitor://localhost.
    androidScheme: 'https',
  },
  android: {
    // Debuggable WebView only in debug builds (Capacitor enables it there automatically; SEC-M08).
    webContentsDebuggingEnabled: false,
    allowMixedContent: false,
  },
  ios: {
    webContentsDebuggingEnabled: false,
  },
};

export default config;
