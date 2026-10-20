import {
  createProviderRegistry,
  DropboxProvider,
  GoogleDriveProvider,
  OneDriveProvider,
  type BackupProvider,
} from '@budget/backup';
import { PRODUCTION_KDF_PARAMS } from '@budget/core';

import type { AppServices, VaultResult, VaultService } from '@/di';
import { createDropboxSession } from '@/cloud/dropbox-session';
import { createGoogleSession } from '@/cloud/google-session';
import { createMicrosoftSession } from '@/cloud/microsoft-session';
import { nativePostForm } from '@/cloud/native-http';
import { createNativeOAuthSession } from '@/cloud/native-oauth';
import { hasAuthBrowser, nativeOAuthConfigs } from '@/cloud/native-providers';
import { parseCsvInWorker } from '@/features/import-export/csv-parser';
import type { PlatformService } from '@/platform';
import { createWorkerRepositories, startDbWorker } from '@/storage';

/**
 * Android/iOS: sign-in through the system browser and a deep link (BUILD_PLAN 4.3). Popups,
 * MSAL and Google's GIS library do not work in the WebView.
 */
function nativeProviders(platform: PlatformService): BackupProvider[] {
  if (!hasAuthBrowser(platform)) return [];
  const env = import.meta.env;
  const configs = nativeOAuthConfigs(platform, {
    microsoft: env.VITE_MS_CLIENT_ID,
    googleAndroid: env.VITE_GOOGLE_ANDROID_CLIENT_ID,
    googleIos: env.VITE_GOOGLE_IOS_CLIENT_ID,
    dropbox: env.VITE_DROPBOX_APP_KEY,
  });
  const deps = { platform, browser: platform.authBrowser, postForm: nativePostForm };
  const providers: BackupProvider[] = [];
  if (configs.onedrive) {
    providers.push(new OneDriveProvider(createNativeOAuthSession(configs.onedrive, deps)));
  }
  if (configs.gdrive) {
    providers.push(new GoogleDriveProvider(createNativeOAuthSession(configs.gdrive, deps)));
  }
  if (configs.dropbox) {
    providers.push(new DropboxProvider(createNativeOAuthSession(configs.dropbox, deps)));
  }
  return providers;
}

/** Cloud providers whose OAuth client ids are configured in this build (BUILD_PLAN Phase 3). */
function configuredProviders(platform: PlatformService): BackupProvider[] {
  if (platform.isNative()) return nativeProviders(platform);
  const providers: BackupProvider[] = [];
  const msClientId = import.meta.env.VITE_MS_CLIENT_ID;
  if (msClientId) {
    providers.push(
      new OneDriveProvider(
        createMicrosoftSession({
          clientId: msClientId,
          redirectUri: `${window.location.origin}/auth/callback/microsoft`,
        }),
      ),
    );
  }
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (googleClientId) {
    providers.push(new GoogleDriveProvider(createGoogleSession({ clientId: googleClientId })));
  }
  const dropboxAppKey = import.meta.env.VITE_DROPBOX_APP_KEY;
  if (dropboxAppKey) {
    providers.push(
      new DropboxProvider(
        createDropboxSession({
          appKey: dropboxAppKey,
          redirectUri: `${window.location.origin}/auth/callback/dropbox`,
        }),
      ),
    );
  }
  return providers;
}

/**
 * Native shells: SQLCipher through the native vault (BUILD_PLAN 4.2). The plugin code is loaded
 * on first use, so the web bundle never contains it.
 */
function createNativeVaultService(): VaultService {
  let loaded: VaultService | null = null;
  const vault = import('@/storage/native').then((m) => (loaded = m.createNativeVault()));
  return {
    status: async () => (await vault).status(),
    createVault: async (p) => (await vault).createVault(p),
    unlock: async (p) => (await vault).unlock(p),
    lock: async () => (await vault).lock(),
    changePassphrase: async (o, n) => (await vault).changePassphrase(o, n),
    verifyPassphrase: async (p) => (await vault).verifyPassphrase(p),
    flush: async () => (await vault).flush(),
    saveFile: async (name, bytes) => (await vault).saveFile(name, bytes),
    readFile: async (name) => (await vault).readFile(name),
    createRepositories: () => {
      if (!loaded) throw new Error('The vault is locked');
      return loaded.createRepositories();
    },
    requestPersistentStorage: async () => (await vault).requestPersistentStorage(),
    biometrics: {
      isAvailable: async () => (await (await vault).biometrics?.isAvailable()) ?? false,
      isEnabled: async () => (await (await vault).biometrics?.isEnabled()) ?? false,
      enable: async (p) =>
        (await (await vault).biometrics?.enable(p)) ?? { ok: false, error: 'STORAGE_FAILED' },
      disable: async () => (await vault).biometrics?.disable(),
      unlock: async (prompt) =>
        (await (await vault).biometrics?.unlock(prompt)) ?? { ok: false, error: 'FAILED' },
    },
  };
}

/** Browser/PWA: the encrypted storage worker (AD5). */
function createWorkerVaultService(): VaultService {
  const { api, failed } = startDbWorker();
  // Every call fails fast (instead of hanging) if the worker could not load or crashed.
  const call = <T>(p: Promise<T>): Promise<T> => Promise.race([p, failed]);
  const vault: VaultService = {
    status: () => call(api.status()),
    createVault: (p) => call<VaultResult>(api.createVault(p)),
    unlock: (p) => call<VaultResult>(api.unlock(p)),
    lock: () => call(api.lock()),
    changePassphrase: (o, n) => call<VaultResult>(api.changePassphrase(o, n)),
    verifyPassphrase: (p) => call(api.verifyPassphrase(p)),
    flush: () => call(api.flush()),
    saveFile: (name, bytes) => call(api.saveFile(name, bytes)),
    readFile: (name) => call(api.readFile(name)),
    createRepositories: () => createWorkerRepositories(api),
    async requestPersistentStorage() {
      if (typeof navigator.storage.persist !== 'function') return false;
      if (await navigator.storage.persisted()) return true;
      return navigator.storage.persist();
    },
  };
  return vault;
}

/** Production services; the repository provider picks the storage by platform (BUILD_PLAN 4.2). */
export function createBrowserServices(
  platform: PlatformService,
  extraProviders: BackupProvider[] = [],
): AppServices {
  return {
    vault: platform.isNative() ? createNativeVaultService() : createWorkerVaultService(),
    parseCsv: parseCsvInWorker,
    kdfParams: PRODUCTION_KDF_PARAMS,
    appVersion: __APP_VERSION__,
    backupProviders: createProviderRegistry([...configuredProviders(platform), ...extraProviders]),
    platform,
    now: () => new Date(),
  };
}
