import type { MergeResult, Repositories } from '@budget/core';

import {
  openBackup,
  sealBackup,
  type BackupHeader,
  type BackupPayload,
  type OpenOptions,
  type SealOptions,
} from './format';

/** Creates an encrypted backup of the whole ledger (all rows, including tombstones). */
export async function createBackup(
  repos: Pick<Repositories, 'snapshots'>,
  passphrase: string,
  options: SealOptions = {},
): Promise<Uint8Array> {
  return sealBackup(await repos.snapshots.exportSnapshot(), passphrase, options);
}

/** Decrypts and validates a backup file (nothing is written). */
export async function readBackup(
  bytes: Uint8Array,
  passphrase: string,
  options: OpenOptions = {},
): Promise<{ header: BackupHeader; payload: BackupPayload }> {
  return openBackup(bytes, passphrase, options);
}

export type RestoreMode = 'replace' | 'merge';

/**
 * Applies a validated payload. `replace` deletes all data and inserts the backup; `merge` keeps
 * local rows and lets the newest `updatedAt` win per row (tombstones included). Each mode runs in
 * one DB transaction. Settings are replaced only in `replace` mode.
 */
export async function restoreBackup(
  repos: Pick<Repositories, 'snapshots'>,
  payload: BackupPayload,
  mode: RestoreMode,
): Promise<MergeResult | null> {
  const snapshot = {
    categories: payload.categories,
    transactions: payload.transactions,
    settings: payload.settings,
  };
  if (mode === 'replace') {
    await repos.snapshots.replaceAll(snapshot);
    return null;
  }
  return repos.snapshots.mergeAll(snapshot);
}

/** `budget-backup-YYYYMMDD-HHmmss.bgtb` (BUILD_PLAN §4.5), local time. */
export function backupFileName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `budget-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.bgtb`;
}
