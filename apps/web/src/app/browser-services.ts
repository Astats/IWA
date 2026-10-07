import type { AppServices, VaultResult, VaultService } from '@/di';
import { createWorkerRepositories, startDbWorker } from '@/storage';

/** Production services: the encrypted storage worker (AD5). */
export function createBrowserServices(): AppServices {
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
  return { vault, now: () => new Date() };
}
