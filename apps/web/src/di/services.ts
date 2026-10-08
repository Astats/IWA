import type { ProviderRegistry } from '@budget/backup';
import type { KdfParams, Repositories } from '@budget/core';
import type { CsvParseOutcome } from '@budget/core/csv';

import type { VaultResult, VaultStatus } from '@/storage/worker-api';

export type { VaultErrorCode, VaultResult, VaultStatus } from '@/storage/worker-api';

/**
 * Everything the UI may do with the encrypted store. UI code depends on this interface and on the
 * repository interfaces from @budget/core only (BUILD_PLAN §3); the implementation lives in
 * src/app/browser-services.ts (storage worker) or in test fakes.
 */
export interface VaultService {
  status(): Promise<VaultStatus>;
  createVault(passphrase: string): Promise<VaultResult>;
  unlock(passphrase: string): Promise<VaultResult>;
  lock(): Promise<void>;
  changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<VaultResult>;
  verifyPassphrase(passphrase: string): Promise<boolean>;
  flush(): Promise<void>;
  saveFile(name: string, bytes: Uint8Array): Promise<void>;
  readFile(name: string): Promise<Uint8Array | null>;
  /** Repositories over the unlocked store. Only valid while unlocked. */
  createRepositories(): Repositories;
  /** Asks the browser to keep storage persistent. Resolves to false when denied/unsupported. */
  requestPersistentStorage(): Promise<boolean>;
}

export interface AppServices {
  vault: VaultService;
  /** Parses and validates a CSV file off the main thread (BUILD_PLAN 2.2). */
  parseCsv: (file: File) => Promise<CsvParseOutcome>;
  /** Argon2id parameters for backups (also the minimum accepted when opening one). */
  kdfParams: KdfParams;
  appVersion: string;
  /** Cloud backup providers available in this build (BUILD_PLAN Phase 3). */
  backupProviders: ProviderRegistry;
  /** Wall clock (injectable for tests). */
  now: () => Date;
}
