import type { KdfParams } from '@budget/core';
import type { SqlRow, SqlValue } from '@budget/db';

export type StorageKind = 'opfs' | 'indexeddb';

/** Generic, user-facing failure reasons. Never contains secrets or data. */
export type VaultErrorCode =
  | 'WRONG_PASSPHRASE'
  | 'CORRUPT'
  | 'UNSUPPORTED_VERSION'
  | 'NO_VAULT'
  | 'VAULT_EXISTS'
  | 'LOCKED'
  | 'STORAGE_FAILED';

export type VaultResult =
  { ok: true } | { ok: false; error: VaultErrorCode; retryAfterMs?: number };

export interface VaultStatus {
  hasVault: boolean;
  unlocked: boolean;
  storage: StorageKind;
  /** Consecutive failed unlock attempts since the worker started. */
  failedAttempts: number;
}

export interface WorkerStats {
  /** Number of encrypted vault writes since the worker started. */
  persistWrites: number;
}

/** Test-mode configuration. Ignored in production builds (see db.worker.ts). */
export interface WorkerTestConfig {
  forceIndexedDb?: boolean;
  kdfParams?: KdfParams;
  persistDebounceMs?: number;
}

/** RPC surface of the storage worker (exposed with comlink). */
export interface DbWorkerApi {
  configureForTests(config: WorkerTestConfig): Promise<void>;
  status(): Promise<VaultStatus>;
  createVault(passphrase: string): Promise<VaultResult>;
  unlock(passphrase: string): Promise<VaultResult>;
  lock(): Promise<void>;
  changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<VaultResult>;
  /** Checks a passphrase against the vault without changing state (e.g. before a backup). */
  verifyPassphrase(passphrase: string): Promise<boolean>;
  exec(sql: string, params: SqlValue[]): Promise<{ changes: number }>;
  query(sql: string, params: SqlValue[]): Promise<SqlRow[]>;
  values(sql: string, params: SqlValue[]): Promise<SqlValue[][]>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  exportDatabase(): Promise<Uint8Array>;
  /** Persists pending changes now (called on visibilitychange → hidden). */
  flush(): Promise<void>;
  /** Stores an encrypted file next to the vault (e.g. the automatic pre-restore backup). */
  saveFile(name: string, bytes: Uint8Array): Promise<void>;
  readFile(name: string): Promise<Uint8Array | null>;
  stats(): Promise<WorkerStats>;
}
