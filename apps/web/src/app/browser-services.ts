import type { AppServices, VaultService } from '@/di';
import { createWorkerRepositories, startDbWorker } from '@/storage';

/** Production services: the encrypted storage worker (AD5). */
export function createBrowserServices(): AppServices {
  const { api } = startDbWorker();
  const vault: VaultService = {
    status: () => api.status(),
    createVault: (p) => api.createVault(p),
    unlock: (p) => api.unlock(p),
    lock: () => api.lock(),
    changePassphrase: (o, n) => api.changePassphrase(o, n),
    verifyPassphrase: (p) => api.verifyPassphrase(p),
    flush: () => api.flush(),
    saveFile: (name, bytes) => api.saveFile(name, bytes),
    readFile: (name) => api.readFile(name),
    createRepositories: () => createWorkerRepositories(api),
    async requestPersistentStorage() {
      if (typeof navigator.storage.persist !== 'function') return false;
      if (await navigator.storage.persisted()) return true;
      return navigator.storage.persist();
    },
  };
  return { vault, now: () => new Date() };
}
