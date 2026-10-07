import { kdfParamsSchema, type KdfParams } from '@budget/core';
import { argon2id } from 'hash-wasm';

import { DecryptionError } from './errors';

export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const SALT_BYTES = 16;
/** Wrapped AES-256 DEK: iv (12) + ciphertext (32) + tag (16). */
export const WRAPPED_DEK_BYTES = IV_BYTES + KEY_BYTES + TAG_BYTES;

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

/** Cryptographically secure random bytes (Web Crypto). */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Constant-time comparison for MACs/tags compared outside AES-GCM. The running time depends only
 * on the (public) length, never on the position of the first differing byte.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Derives the key-encryption key (KEK) from a passphrase with Argon2id (AD12). The passphrase is
 * NFC-normalized so the same text typed on different devices yields the same key. The KEK is a
 * non-extractable AES-GCM key usable only to wrap/unwrap the DEK.
 */
export async function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<CryptoKey> {
  const p = kdfParamsSchema.parse(params);
  const raw = await argon2id({
    password: new TextEncoder().encode(passphrase.normalize('NFC')),
    salt,
    parallelism: p.parallelism,
    iterations: p.iterations,
    memorySize: p.memoryKiB,
    hashLength: KEY_BYTES,
    outputType: 'binary',
  });
  const keyBytes = copy(raw);
  raw.fill(0);
  try {
    return await subtle().importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
      'wrapKey',
      'unwrapKey',
    ]);
  } finally {
    keyBytes.fill(0);
  }
}

/** New random 256-bit data-encryption key. Extractable only so it can be wrapped. */
export async function generateDek(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** Wraps (encrypts) the DEK with the KEK using AES-GCM. Output: iv ‖ ciphertext ‖ tag. */
export async function wrapDek(
  dek: CryptoKey,
  kek: CryptoKey,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES);
  const wrapped = await subtle().wrapKey('raw', dek, kek, {
    name: 'AES-GCM',
    iv,
    additionalData: copy(aad),
  });
  return concat(iv, new Uint8Array(wrapped));
}

/**
 * Unwraps the DEK. By default the result is non-extractable (`exportKey` rejects); `extractable`
 * is only for re-wrapping during a passphrase change.
 */
export async function unwrapDek(
  wrapped: Uint8Array,
  kek: CryptoKey,
  aad: Uint8Array,
  { extractable = false }: { extractable?: boolean } = {},
): Promise<CryptoKey> {
  if (wrapped.length !== WRAPPED_DEK_BYTES) throw new DecryptionError();
  try {
    return await subtle().unwrapKey(
      'raw',
      copy(wrapped.subarray(IV_BYTES)),
      kek,
      { name: 'AES-GCM', iv: copy(wrapped.subarray(0, IV_BYTES)), additionalData: copy(aad) },
      { name: 'AES-GCM', length: 256 },
      extractable,
      ['encrypt', 'decrypt'],
    );
  } catch {
    throw new DecryptionError();
  }
}

/** Re-wraps a DEK under a new KEK (passphrase change); the data itself is not re-encrypted. */
export async function rewrapDek(
  wrapped: Uint8Array,
  oldKek: CryptoKey,
  oldAad: Uint8Array,
  newKek: CryptoKey,
  newAad: Uint8Array,
): Promise<Uint8Array> {
  const dek = await unwrapDek(wrapped, oldKek, oldAad, { extractable: true });
  return wrapDek(dek, newKek, newAad);
}

/** AES-256-GCM with a fresh random 12-byte IV. Output: iv ‖ ciphertext ‖ tag. */
export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: copy(aad) },
    key,
    copy(plaintext),
  );
  return concat(iv, new Uint8Array(ct));
}

/** Inverse of {@link encrypt}. Any failure (wrong key, tampering, truncation) → DecryptionError. */
export async function decrypt(
  key: CryptoKey,
  blob: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new DecryptionError();
  try {
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: copy(blob.subarray(0, IV_BYTES)), additionalData: copy(aad) },
      key,
      copy(blob.subarray(IV_BYTES)),
    );
    return new Uint8Array(pt);
  } catch {
    throw new DecryptionError();
  }
}

/** Copies into a fresh ArrayBuffer-backed array (Web Crypto rejects SharedArrayBuffer views). */
function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
