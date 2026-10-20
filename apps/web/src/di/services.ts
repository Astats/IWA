import type { ProviderRegistry } from '@budget/backup';
import type { KdfParams, Repositories } from '@budget/core';
import type { CsvParseOutcome } from '@budget/core/csv';

import type { PlatformService } from '@/platform';
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
  /** Native only: unlocking with fingerprint or face (BUILD_PLAN 4.3). */
  readonly biometrics?: BiometricUnlock;
}

/** Texts of the system biometric prompt (translated by the caller). */
export interface BiometricPromptText {
  title: string;
  cancel: string;
}

export type BiometricErrorCode =
  /** The user closed the prompt or chose the passphrase. */
  | 'CANCELLED'
  /** Too many failed attempts; the system blocks biometrics for a while. */
  | 'LOCKED_OUT'
  /** The biometric key is gone (e.g. fingerprints changed); biometric unlock was turned off. */
  | 'INVALIDATED'
  | 'FAILED';

export type BiometricResult = { ok: true } | { ok: false; error: BiometricErrorCode };

/**
 * Biometric unlock keeps a copy of the vault key wrapped by a Keystore/Keychain key that only a
 * successful strong-biometric check releases. The passphrase always works as well.
 */
export interface BiometricUnlock {
  /** Strong biometrics are set up on this device. */
  isAvailable(): Promise<boolean>;
  /** Biometric unlock is turned on (readable while locked). */
  isEnabled(): Promise<boolean>;
  /** Turns it on. Needs the unlocked vault and the passphrase again (re-authentication). */
  enable(passphrase: string): Promise<VaultResult>;
  disable(): Promise<void>;
  /** Shows the system prompt and unlocks the vault. */
  unlock(prompt: BiometricPromptText): Promise<BiometricResult>;
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
  /** Browser or native shell: file saving and app links (BUILD_PLAN 4.1). */
  platform: PlatformService;
  /** Wall clock (injectable for tests). */
  now: () => Date;
}
