import {
  categorySchema,
  kdfParamsSchema,
  meetsMinimumKdf,
  PRODUCTION_KDF_PARAMS,
  settingsSchema,
  transactionSchema,
  type KdfParams,
  type LedgerSnapshot,
} from '@budget/core';
import {
  concat,
  decrypt,
  deriveKey,
  encrypt,
  FormatError,
  IV_BYTES,
  KdfPolicyError,
  randomBytes,
  SALT_BYTES,
  TAG_BYTES,
  UnsupportedVersionError,
} from '@budget/crypto';
import { z } from 'zod';

/*
 * Backup file (BUILD_PLAN §4.5):
 *
 *   magic "BGTB" | format_version u8 | created_at (u16 len + UTF-8) | app_version (u16 len + UTF-8) |
 *   kdf_params (u16 len + JSON) | salt 16B | iv 12B | ciphertext of gzip(JSON payload) + tag
 *
 * The key is derived from the passphrase with Argon2id and a fresh salt per backup, so a backup can
 * be restored on a new device. Every byte before the IV is AES-GCM additional authenticated data.
 */
export const BACKUP_MAGIC = new TextEncoder().encode('BGTB');
export const BACKUP_FORMAT_VERSION = 1;
/** Decompressed payload limit (gzip-bomb guard). */
export const MAX_PAYLOAD_BYTES = 200 * 1024 * 1024;
/** Encrypted file size limit (refuse to even read larger files). */
export const MAX_BACKUP_FILE_BYTES = 100 * 1024 * 1024;
const MAX_HEADER_STRING = 1024;

/** Thrown when the decrypted payload is not a valid backup (fails closed; nothing is restored). */
export class BackupPayloadError extends Error {
  override readonly name = 'BackupPayloadError';

  constructor(message = 'Invalid backup contents') {
    super(message);
  }
}

export const backupPayloadSchema = z.object({
  schemaVersion: z.number().int().min(1),
  categories: z.array(categorySchema),
  transactions: z.array(transactionSchema),
  settings: settingsSchema,
});
export type BackupPayload = z.infer<typeof backupPayloadSchema>;

export interface BackupHeader {
  version: number;
  createdAt: string;
  appVersion: string;
  kdfParams: KdfParams;
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

function lengthPrefixed(text: string): Uint8Array {
  const bytes = enc.encode(text);
  if (bytes.length > MAX_HEADER_STRING) throw new RangeError('Header field too long');
  const len = new Uint8Array(2);
  new DataView(len.buffer).setUint16(0, bytes.length);
  return concat(len, bytes);
}

async function pipeBytes(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
  limit: number,
) {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  const reader = source.pipeThrough(transform).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new BackupPayloadError('Backup payload is too large');
    }
    chunks.push(value);
  }
  return concat(...chunks);
}

export function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipeBytes(bytes, new CompressionStream('gzip'), Number.MAX_SAFE_INTEGER);
}

/** Gunzips with a hard output limit, so a gzip bomb is rejected instead of exhausting memory. */
export async function gunzip(bytes: Uint8Array, limit = MAX_PAYLOAD_BYTES): Promise<Uint8Array> {
  try {
    return await pipeBytes(bytes, new DecompressionStream('gzip'), limit);
  } catch (err) {
    if (err instanceof BackupPayloadError) throw err;
    throw new BackupPayloadError('Backup payload is not valid gzip');
  }
}

export interface SealOptions {
  kdfParams?: KdfParams;
  appVersion?: string;
  now?: () => Date;
}

/** Encrypts a snapshot into a backup file. */
export async function sealBackup(
  snapshot: LedgerSnapshot,
  passphrase: string,
  {
    kdfParams = PRODUCTION_KDF_PARAMS,
    appVersion = '0.0.0',
    now = () => new Date(),
  }: SealOptions = {},
): Promise<Uint8Array> {
  const payload: BackupPayload = {
    schemaVersion: snapshot.settings.schemaVersion,
    categories: snapshot.categories,
    transactions: snapshot.transactions,
    settings: snapshot.settings,
  };
  const salt = randomBytes(SALT_BYTES);
  const header = concat(
    BACKUP_MAGIC,
    Uint8Array.of(BACKUP_FORMAT_VERSION),
    lengthPrefixed(now().toISOString()),
    lengthPrefixed(appVersion),
    lengthPrefixed(JSON.stringify(kdfParamsSchema.parse(kdfParams))),
    salt,
  );
  const key = await deriveKey(passphrase, salt, kdfParams, ['encrypt']);
  const compressed = await gzip(enc.encode(JSON.stringify(payload)));
  return concat(header, await encrypt(key, compressed, header));
}

interface ParsedBackup {
  header: BackupHeader;
  salt: Uint8Array;
  aad: Uint8Array;
  sealed: Uint8Array;
}

/** Parses the unencrypted header. Throws FormatError / UnsupportedVersionError. */
export function parseBackupHeader(bytes: Uint8Array): ParsedBackup {
  if (bytes.length > MAX_BACKUP_FILE_BYTES) throw new FormatError('Backup file is too large');
  if (bytes.length < 5 || BACKUP_MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new FormatError('Not a backup file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  if (version > BACKUP_FORMAT_VERSION)
    throw new UnsupportedVersionError(version, BACKUP_FORMAT_VERSION);
  if (version < 1) throw new FormatError('Invalid backup version');
  let offset = 5;
  const readString = (): string => {
    if (offset + 2 > bytes.length) throw new FormatError('Backup file is truncated');
    const len = view.getUint16(offset);
    offset += 2;
    if (len > MAX_HEADER_STRING || offset + len > bytes.length)
      throw new FormatError('Backup file is truncated');
    try {
      return dec.decode(bytes.subarray(offset, (offset += len)));
    } catch {
      throw new FormatError('Invalid backup header');
    }
  };
  const createdAt = readString();
  const appVersion = readString();
  let kdfParams: KdfParams;
  try {
    kdfParams = kdfParamsSchema.parse(JSON.parse(readString()));
  } catch (err) {
    if (err instanceof FormatError) throw err;
    throw new FormatError('Invalid KDF header');
  }
  if (offset + SALT_BYTES + IV_BYTES + TAG_BYTES > bytes.length)
    throw new FormatError('Backup file is truncated');
  const salt = bytes.slice(offset, offset + SALT_BYTES);
  offset += SALT_BYTES;
  return {
    header: { version, createdAt, appVersion, kdfParams },
    salt,
    aad: bytes.slice(0, offset),
    sealed: bytes.slice(offset),
  };
}

export interface OpenOptions {
  /** Minimum accepted KDF parameters (downgrade guard). Defaults to production. */
  minKdf?: KdfParams;
  maxPayloadBytes?: number;
}

/**
 * Decrypts and validates a backup. Fails closed: wrong passphrase or tampering → DecryptionError;
 * bad structure → FormatError; newer format → UnsupportedVersionError; invalid contents →
 * BackupPayloadError. Never returns partial data.
 */
export async function openBackup(
  bytes: Uint8Array,
  passphrase: string,
  { minKdf = PRODUCTION_KDF_PARAMS, maxPayloadBytes = MAX_PAYLOAD_BYTES }: OpenOptions = {},
): Promise<{ header: BackupHeader; payload: BackupPayload }> {
  const parsed = parseBackupHeader(bytes);
  if (!meetsMinimumKdf(parsed.header.kdfParams, minKdf)) throw new KdfPolicyError();
  const key = await deriveKey(passphrase, parsed.salt, parsed.header.kdfParams, ['decrypt']);
  const compressed = await decrypt(key, parsed.sealed, parsed.aad);
  const json = await gunzip(compressed, maxPayloadBytes);
  let data: unknown;
  try {
    data = JSON.parse(dec.decode(json));
  } catch {
    throw new BackupPayloadError('Backup payload is not valid JSON');
  }
  const result = backupPayloadSchema.safeParse(data);
  if (!result.success) throw new BackupPayloadError();
  return { header: parsed.header, payload: result.data };
}
