import process from 'node:process';

import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native shell for Android (BUILD_PLAN 4.1, AD2). The WebView loads the built PWA from
 * `dist/`; nothing is fetched from a remote server.
 */
const config: CapacitorConfig = {
  appId: 'com.astats.budget',
  appName: 'Budget',
  // CAP_WEB_DIR: only scripts/native-contract.mjs points this at the instrumented test build.
  webDir: process.env.CAP_WEB_DIR ?? 'dist',
  // No native logging in any build (SEC-M02): in debug builds Capacitor logs every plugin call
  // with its arguments, which would put the SQLCipher secret into logcat. Use WebView DevTools.
  loggingBehavior: 'none',
  server: {
    // Secure context (Web Crypto, OPFS) at https://localhost.
    androidScheme: 'https',
  },
  android: {
    // Debuggable WebView only in debug builds (Capacitor enables it there automatically; SEC-M08).
    webContentsDebuggingEnabled: false,
    allowMixedContent: false,
  },
  plugins: {
    // SQLCipher (BUILD_PLAN 4.2). The secret store is backed by the Android Keystore; the
    // native vault puts the secret there only while the app is unlocked (src/storage/native).
    CapacitorSQLite: {
      androidIsEncryption: true,
      androidBiometric: { biometricAuth: false },
    },
  },
};

export default config;
