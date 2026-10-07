import { PRODUCTION_KDF_PARAMS } from '@budget/core';
import { testKdfParams } from '@budget/core/testing';
import { argon2id } from 'hash-wasm';
import { describe, expect, it } from 'vitest';

import { DecryptionError } from './errors';
import {
  constantTimeEqual,
  decrypt,
  deriveKek,
  encrypt,
  generateDek,
  IV_BYTES,
  randomBytes,
  rewrapDek,
  unwrapDek,
  wrapDek,
} from './primitives';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const AAD = enc('header');

async function aKey(): Promise<CryptoKey> {
  const kek = await deriveKek('correct horse battery', new Uint8Array(16).fill(1), testKdfParams);
  const wrapped = await wrapDek(await generateDek(), kek, AAD);
  return unwrapDek(wrapped, kek, AAD);
}

describe('Argon2id known-answer tests (hash-wasm regression guard)', () => {
  it.each([
    {
      // Reference implementation (phc-winner-argon2) test vector, argon2id v19.
      password: enc('password'),
      salt: enc('somesalt'),
      iterations: 2,
      memorySize: 65536,
      parallelism: 1,
      expected: '09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7',
    },
    {
      // RFC 9106 §5.3 inputs (password 0x01×32, salt 0x02×16, secret 0x03×8) without associated
      // data, cross-checked against Node's built-in crypto.argon2.
      password: new Uint8Array(32).fill(1),
      salt: new Uint8Array(16).fill(2),
      secret: new Uint8Array(8).fill(3),
      iterations: 3,
      memorySize: 32,
      parallelism: 4,
      expected: '0034de3c8a75efc1148100eaf5ba9b1ce6d50ba5cdf6ae4018c54a4fc03ac10d',
    },
  ])('matches $expected', async ({ expected, ...params }) => {
    const hash = await argon2id({ ...params, hashLength: 32, outputType: 'hex' });

    expect(hash).toBe(expected);
  });
});

describe('deriveKek', () => {
  it('produces a non-extractable AES-GCM wrapping key', async () => {
    const kek = await deriveKek('passphrase here', randomBytes(16), testKdfParams);

    expect(kek.extractable).toBe(false);
    expect(kek.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(kek.usages.sort()).toEqual(['unwrapKey', 'wrapKey']);
  });

  it('normalizes the passphrase (NFC) so composed and decomposed input match', async () => {
    const salt = randomBytes(16);
    const composed = await deriveKek('jūra ēna ķirbis', salt, testKdfParams);
    const decomposed = await deriveKek('jūra ēna ķirbis'.normalize('NFD'), salt, testKdfParams);
    const wrapped = await wrapDek(await generateDek(), composed, AAD);

    await expect(unwrapDek(wrapped, decomposed, AAD)).resolves.toBeTruthy();
  });

  it('rejects invalid parameters', async () => {
    await expect(
      deriveKek('x', randomBytes(16), { ...testKdfParams, iterations: 0 }),
    ).rejects.toThrow();
  });

  it('production parameters cost between 200 ms (on CI) and 2 s', async () => {
    const start = performance.now();
    await deriveKek('a long enough passphrase', randomBytes(16), PRODUCTION_KDF_PARAMS);
    const ms = performance.now() - start;

    expect(ms).toBeLessThanOrEqual(2000);
    // Local dev machines can be faster than CI runners; the floor is enforced on CI hardware.
    if (process.env.CI) expect(ms).toBeGreaterThanOrEqual(200);
  });
});

describe('DEK wrapping', () => {
  it('unwrapped DEK is non-extractable and exportKey rejects', async () => {
    const dek = await aKey();

    expect(dek.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('raw', dek)).rejects.toThrow();
  });

  it('wrong KEK, wrong AAD or tampered wrapping → DecryptionError', async () => {
    const kek = await deriveKek('passphrase one', randomBytes(16), testKdfParams);
    const other = await deriveKek('passphrase two', randomBytes(16), testKdfParams);
    const wrapped = await wrapDek(await generateDek(), kek, AAD);
    const tampered = wrapped.slice();
    tampered[20] = (tampered[20] ?? 0) ^ 1;

    await expect(unwrapDek(wrapped, other, AAD)).rejects.toBeInstanceOf(DecryptionError);
    await expect(unwrapDek(wrapped, kek, enc('other'))).rejects.toBeInstanceOf(DecryptionError);
    await expect(unwrapDek(tampered, kek, AAD)).rejects.toBeInstanceOf(DecryptionError);
    await expect(unwrapDek(wrapped.subarray(1), kek, AAD)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('rewrapDek moves the same DEK under a new KEK', async () => {
    const oldKek = await deriveKek('old passphrase', randomBytes(16), testKdfParams);
    const newKek = await deriveKek('new passphrase', randomBytes(16), testKdfParams);
    const original = await generateDek();
    const wrapped = await wrapDek(original, oldKek, AAD);
    const blob = await encrypt(original, enc('ledger'), AAD);

    const rewrapped = await rewrapDek(wrapped, oldKek, AAD, newKek, enc('new header'));
    const dek = await unwrapDek(rewrapped, newKek, enc('new header'));

    expect(dec(await decrypt(dek, blob, AAD))).toBe('ledger');
    await expect(unwrapDek(rewrapped, oldKek, enc('new header'))).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });
});

describe('encrypt / decrypt (AES-256-GCM)', () => {
  it.each([
    ['empty', new Uint8Array(0)],
    ['1 byte', Uint8Array.of(42)],
    ['10 MB', new Uint8Array(10 * 1024 * 1024).fill(7)],
  ])('round-trips a %s payload', async (_label, plaintext) => {
    const key = await aKey();

    const blob = await encrypt(key, plaintext, AAD);

    expect(blob.length).toBe(IV_BYTES + plaintext.length + 16);
    const out = await decrypt(key, blob, AAD);
    // Byte comparison: toEqual deep-diffs huge typed arrays very slowly.
    expect(out.length).toBe(plaintext.length);
    expect(out.every((b, i) => b === plaintext[i])).toBe(true);
  });

  it.each([
    ['IV', 0],
    ['ciphertext', IV_BYTES],
    ['tag', -1],
  ])('a flipped bit in the %s → DecryptionError', async (_part, index) => {
    const key = await aKey();
    const blob = await encrypt(key, enc('secret data'), AAD);
    const i = index < 0 ? blob.length + index : index;
    blob[i] = (blob[i] ?? 0) ^ 0x01;

    await expect(decrypt(key, blob, AAD)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('wrong AAD, wrong key and truncation → DecryptionError', async () => {
    const key = await aKey();
    const blob = await encrypt(key, enc('secret data'), AAD);

    await expect(decrypt(key, blob, enc('headex'))).rejects.toBeInstanceOf(DecryptionError);
    await expect(decrypt(await aKey(), blob, AAD)).rejects.toBeInstanceOf(DecryptionError);
    await expect(decrypt(key, blob.subarray(0, blob.length - 1), AAD)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(decrypt(key, blob.subarray(0, 10), AAD)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('uses a unique IV for 10,000 encryptions with the same key', async () => {
    const key = await aKey();
    const ivs = new Set<string>();

    for (let i = 0; i < 10_000; i++) {
      const blob = await encrypt(key, Uint8Array.of(i & 0xff), AAD);
      ivs.add(Array.from(blob.subarray(0, IV_BYTES)).join(','));
    }

    expect(ivs.size).toBe(10_000);
  });
});

describe('constantTimeEqual', () => {
  it('compares byte arrays', () => {
    expect(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
    expect(constantTimeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false);
    expect(constantTimeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});
