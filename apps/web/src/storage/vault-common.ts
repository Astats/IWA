import {
  DecryptionError,
  FormatError,
  UnsupportedVersionError,
  VaultNotFoundError,
} from '@budget/crypto';

import type { VaultErrorCode } from './worker-api';

/** Shared by the storage worker (web) and the native vault (Android). */

const MAX_UNLOCK_DELAY_MS = 30_000;

/** Progressive delay before an unlock attempt: 0, 1 s, 2 s, 4 s … capped at 30 s. */
export function unlockDelayMs(failedAttempts: number): number {
  return failedAttempts === 0 ? 0 : Math.min(1000 * 2 ** (failedAttempts - 1), MAX_UNLOCK_DELAY_MS);
}

export function toErrorCode(err: unknown): VaultErrorCode {
  if (err instanceof DecryptionError) return 'WRONG_PASSPHRASE';
  if (err instanceof UnsupportedVersionError) return 'UNSUPPORTED_VERSION';
  if (err instanceof VaultNotFoundError) return 'NO_VAULT';
  if (err instanceof FormatError) return 'CORRUPT';
  return 'STORAGE_FAILED';
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Names for side files next to the vault (e.g. `pre-restore.bgtb`). */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name)) throw new Error('Invalid file name');
}
