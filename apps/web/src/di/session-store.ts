import type { Repositories, Settings } from '@budget/core';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { StorageKind } from '@/storage/worker-api';

import type { BiometricPromptText, BiometricResult, VaultResult, VaultService } from './services';

export type SessionStatus = 'checking' | 'no-vault' | 'locked' | 'unlocked' | 'error';

export interface SessionState {
  status: SessionStatus;
  repos: Repositories | null;
  storage: StorageKind | null;
  /** False when the browser denied persistent storage (show a warning banner). */
  storagePersisted: boolean | null;
  /** Re-reads vault state from the storage worker. */
  refresh: () => Promise<void>;
  createVault: (
    passphrase: string,
    setup: Pick<Settings, 'baseCurrency' | 'locale'>,
  ) => Promise<VaultResult>;
  unlock: (passphrase: string) => Promise<VaultResult>;
  /** Native only: unlock through the system biometric prompt (BUILD_PLAN 4.3). */
  unlockWithBiometrics: (prompt: BiometricPromptText) => Promise<BiometricResult>;
  lock: () => Promise<void>;
}

export type SessionStore = StoreApi<SessionState>;

/**
 * Session state machine: checking → no-vault | locked ⇄ unlocked. Locking drops the repositories
 * (and the worker drops the DEK); `onLock` lets the app clear caches.
 */
export function createSessionStore(
  vault: VaultService,
  onLock: () => void = () => {},
): SessionStore {
  return createStore<SessionState>()((set, get) => {
    const becomeUnlocked = async () => {
      set({ status: 'unlocked', repos: vault.createRepositories() });
      const persisted = await vault.requestPersistentStorage().catch(() => false);
      set({ storagePersisted: persisted });
    };

    return {
      status: 'checking',
      repos: null,
      storage: null,
      storagePersisted: null,

      async refresh() {
        try {
          const s = await vault.status();
          set({
            storage: s.storage,
            status: s.unlocked ? 'unlocked' : s.hasVault ? 'locked' : 'no-vault',
            repos: s.unlocked ? (get().repos ?? vault.createRepositories()) : null,
          });
        } catch {
          set({ status: 'error', repos: null });
        }
      },

      async createVault(passphrase, setup) {
        const result = await vault.createVault(passphrase);
        if (!result.ok) return result;
        const repos = vault.createRepositories();
        await repos.categories.seedDefaults();
        await repos.settings.set('baseCurrency', setup.baseCurrency);
        await repos.settings.set('locale', setup.locale);
        await vault.flush();
        await becomeUnlocked();
        return result;
      },

      async unlock(passphrase) {
        const result = await vault.unlock(passphrase);
        if (result.ok) await becomeUnlocked();
        return result;
      },

      async unlockWithBiometrics(prompt) {
        if (!vault.biometrics) return { ok: false, error: 'FAILED' };
        const result = await vault.biometrics.unlock(prompt);
        if (result.ok) await becomeUnlocked();
        return result;
      },

      async lock() {
        set({ status: 'locked', repos: null });
        onLock();
        await vault.lock();
      },
    };
  });
}
