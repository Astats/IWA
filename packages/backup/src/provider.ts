import { z } from 'zod';

/*
 * Cloud backup providers (BUILD_PLAN AD14, Phase 3). Providers only ever store ciphertext: the
 * caller encrypts with `createBackup` before `upload` and decrypts after `download` (AD13).
 */

export const PROVIDER_IDS = ['onedrive', 'gdrive', 'dropbox', 'fake'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** A backup file stored at a provider. `id` is the provider's own file id. */
export interface RemoteBackup {
  id: string;
  name: string;
  size: number;
  /** ISO 8601 timestamp (when the provider stored the file). */
  createdAt: string;
}

/** Remote file names the app writes and lists (`budget-backup-YYYYMMDD-HHmmss.bgtb`). */
export const BACKUP_NAME_PATTERN = /^budget-backup-\d{8}-\d{6}\.bgtb$/;

/** Provider responses are external input: validated at the boundary (BUILD_PLAN §6.1). */
export const remoteBackupSchema = z.object({
  id: z.string().min(1).max(1024),
  name: z.string().regex(BACKUP_NAME_PATTERN),
  size: z.number().int().min(0),
  createdAt: z.iso.datetime({ offset: true }),
});

export type ProviderErrorCode =
  /** Not connected, or the token expired / was revoked: the user has to connect again. */
  | 'AUTH_REQUIRED'
  /** The user closed the sign-in window or denied consent. */
  | 'CANCELLED'
  /** The provider refused the operation (e.g. missing permission for the app folder). */
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  /** Provider-side failure (5xx) after retries. */
  | 'UNAVAILABLE'
  /** The request did not reach the provider (offline, DNS, CORS, aborted). */
  | 'NETWORK'
  /** The provider answered with something the app does not understand. */
  | 'INVALID_RESPONSE'
  /** The app is not configured for this provider (missing client id). */
  | 'NOT_CONFIGURED';

/** Typed provider failure. Messages are for logs only; the UI maps `code` to translated text. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';

  constructor(
    readonly code: ProviderErrorCode,
    message: string = code,
    /** HTTP status, when the error came from a provider response. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * One cloud storage account. Implementations keep their tokens in memory only on the web
 * (BUILD_PLAN §6.1); `disconnect()` forgets them locally.
 */
export interface BackupProvider {
  readonly id: ProviderId;
  /** True while the provider holds a usable session. */
  isConnected(): boolean;
  /** Signs in (OAuth popup/redirect). Throws ProviderError('CANCELLED') when the user aborts. */
  connect(): Promise<void>;
  /** Backups in the app folder, newest first. Foreign files are ignored. */
  list(): Promise<RemoteBackup[]>;
  /** Stores a complete file. A failed upload must never leave a partial file under `name`. */
  upload(name: string, bytes: Uint8Array): Promise<RemoteBackup>;
  download(id: string): Promise<Uint8Array>;
  delete(id: string): Promise<void>;
  /** Forgets the session on this device (tokens dropped from memory). */
  disconnect(): Promise<void>;
}

/** Validates, filters (backup names only) and sorts a provider listing, newest first. */
export function normalizeListing(items: readonly unknown[]): RemoteBackup[] {
  const result: RemoteBackup[] = [];
  for (const item of items) {
    const parsed = remoteBackupSchema.safeParse(item);
    if (parsed.success) result.push(parsed.data);
  }
  return result.sort(compareNewestFirst);
}

/**
 * Newest first. The file name carries the creation time with second precision, so it decides;
 * the provider timestamp only breaks ties.
 */
export function compareNewestFirst(a: RemoteBackup, b: RemoteBackup): number {
  if (a.name !== b.name) return a.name < b.name ? 1 : -1;
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

export interface ProviderRegistry {
  /** All available providers, in display order. */
  all(): readonly BackupProvider[];
  get(id: ProviderId): BackupProvider | undefined;
  /** Forgets every session (used when the app locks). */
  disconnectAll(): Promise<void>;
}

export function createProviderRegistry(providers: readonly BackupProvider[]): ProviderRegistry {
  const byId = new Map<ProviderId, BackupProvider>();
  for (const provider of providers) {
    if (byId.has(provider.id)) throw new Error(`Duplicate backup provider: ${provider.id}`);
    byId.set(provider.id, provider);
  }
  const list = [...byId.values()];
  return {
    all: () => list,
    get: (id) => byId.get(id),
    async disconnectAll() {
      await Promise.allSettled(list.map((p) => p.disconnect()));
    },
  };
}

export interface RetentionResult {
  kept: RemoteBackup[];
  deleted: RemoteBackup[];
  /** Old backups that could not be deleted (retried on the next run). */
  failed: RemoteBackup[];
}

/**
 * Deletes all but the newest `keep` backups. The backup with id `protect` (the one just uploaded)
 * is always kept, even if a wrong device clock sorted it as old. Deletion failures do not throw.
 */
export async function applyRetention(
  provider: BackupProvider,
  keep: number,
  protect?: string,
): Promise<RetentionResult> {
  if (!Number.isInteger(keep) || keep < 1) throw new RangeError('keep must be a positive integer');
  const all = await provider.list();
  const protectedItem = all.find((b) => b.id === protect);
  const others = all.filter((b) => b !== protectedItem);
  const kept = protectedItem
    ? [protectedItem, ...others.slice(0, keep - 1)].sort(compareNewestFirst)
    : others.slice(0, keep);
  const deleted: RemoteBackup[] = [];
  const failed: RemoteBackup[] = [];
  for (const old of others.filter((b) => !kept.includes(b))) {
    try {
      await provider.delete(old.id);
      deleted.push(old);
    } catch {
      failed.push(old);
    }
  }
  return { kept, deleted, failed };
}

export interface UploadBackupResult {
  uploaded: RemoteBackup;
  retention: RetentionResult | null;
}

/**
 * Uploads an already encrypted backup and then applies retention. A retention failure (listing
 * error) does not fail the backup: the upload already succeeded.
 */
export async function uploadBackup(
  provider: BackupProvider,
  name: string,
  bytes: Uint8Array,
  keep: number,
): Promise<UploadBackupResult> {
  if (!BACKUP_NAME_PATTERN.test(name)) throw new RangeError('Invalid backup file name');
  const uploaded = await provider.upload(name, bytes);
  let retention: RetentionResult | null = null;
  try {
    retention = await applyRetention(provider, keep, uploaded.id);
  } catch {
    retention = null;
  }
  return { uploaded, retention };
}
