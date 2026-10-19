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
import { parseCsvInWorker } from '@/features/import-export/csv-parser';
import type { PlatformService } from '@/platform';
import { createWorkerRepositories, startDbWorker } from '@/storage';

/** Cloud providers whose OAuth client ids are configured in this build (BUILD_PLAN Phase 3). */
function configuredProviders(): BackupProvider[] {
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
    backupProviders: createProviderRegistry([...configuredProviders(), ...extraProviders]),
    platform,
    now: () => new Date(),
  };
}
