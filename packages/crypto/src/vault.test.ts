import { PRODUCTION_KDF_PARAMS } from '@budget/core';
import { testKdfParams } from '@budget/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DecryptionError,
  FormatError,
  KdfPolicyError,
  UnsupportedVersionError,
  VaultNotFoundError,
} from './errors';
import { MemoryVaultStore, parseVault, Vault, VAULT_FORMAT_VERSION } from './vault';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const PASS = 'tulip river quiet lamp';
const opts = { minKdf: testKdfParams };

let store: MemoryVaultStore;

beforeEach(() => {
  store = new MemoryVaultStore();
});

async function createVault(data = 'v1') {
  return Vault.create(store, PASS, enc(data), { kdfParams: testKdfParams });
}

function slotBytes(slot: 'A' | 'B'): Uint8Array {
  const bytes = store.slots.get(slot);
  if (!bytes) throw new Error(`slot ${slot} empty`);
  return bytes;
}

describe('Vault.create / open', () => {
  it('round-trips data and reports existence', async () => {
    expect(await Vault.exists(store)).toBe(false);
    await createVault('hello ledger');

    const { plaintext, vault } = await Vault.open(store, PASS, opts);

    expect(await Vault.exists(store)).toBe(true);
    expect(dec(plaintext)).toBe('hello ledger');
    expect(vault.generation).toBe(2n);
    expect(vault.kdfParams).toEqual(testKdfParams);
  });

  it('stores no plaintext in the slots', async () => {
    await createVault('MARKER-NOTE-12345');

    for (const slot of ['A', 'B'] as const) {
      expect(dec(slotBytes(slot))).not.toContain('MARKER-NOTE-12345');
    }
  });

  it('wrong passphrase → DecryptionError', async () => {
    await createVault();

    await expect(Vault.open(store, 'wrong passphrase!', opts)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it('no vault → VaultNotFoundError', async () => {
    await expect(Vault.open(store, PASS, opts)).rejects.toBeInstanceOf(VaultNotFoundError);
  });
});

describe('Vault.save (A/B slots)', () => {
  it('alternates slots with increasing generations', async () => {
    const vault = await createVault();

    await vault.save(enc('v2'));
    const genA = parseVault(slotBytes('A')).generation;
    const genB = parseVault(slotBytes('B')).generation;

    expect([genA, genB].sort()).toEqual([2n, 3n]);
    expect(vault.generation).toBe(3n);
    expect(dec((await Vault.open(store, PASS, opts)).plaintext)).toBe('v2');
  });

  it('newest slot corrupted → the previous generation loads', async () => {
    const vault = await createVault('old');
    await vault.save(enc('new'));
    const newest = parseVault(slotBytes('A')).generation === 3n ? 'A' : 'B';
    const bytes = slotBytes(newest);
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 0xff;

    const { plaintext, vault: reopened } = await Vault.open(store, PASS, opts);

    expect(dec(plaintext)).toBe('old');
    expect(reopened.generation).toBe(2n);
  });

  it('newest slot truncated mid-write → the previous generation loads, next save overwrites it', async () => {
    const vault = await createVault('old');
    await vault.save(enc('new'));
    const newest = parseVault(slotBytes('A')).generation === 3n ? 'A' : 'B';
    store.slots.set(newest, slotBytes(newest).subarray(0, 40));

    const { plaintext, vault: reopened } = await Vault.open(store, PASS, opts);
    await reopened.save(enc('after crash'));

    expect(dec(plaintext)).toBe('old');
    expect(dec((await Vault.open(store, PASS, opts)).plaintext)).toBe('after crash');
  });

  it('both slots corrupted → typed error and nothing is overwritten', async () => {
    await createVault();
    for (const slot of ['A', 'B'] as const) {
      const bytes = slotBytes(slot);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    }
    const before = [slotBytes('A').slice(), slotBytes('B').slice()];
    const writes = store.writes;

    await expect(Vault.open(store, PASS, opts)).rejects.toBeInstanceOf(DecryptionError);
    expect(store.writes).toBe(writes);
    expect([slotBytes('A'), slotBytes('B')]).toEqual(before);
  });

  it('both slots garbage → FormatError', async () => {
    await store.write('A', enc('not a vault at all, just text that is long enough to parse'));
    await store.write('B', new Uint8Array(3));

    await expect(Vault.open(store, PASS, opts)).rejects.toBeInstanceOf(FormatError);
  });

  it('serializes concurrent saves', async () => {
    const vault = await createVault();

    await Promise.all([vault.save(enc('a')), vault.save(enc('b')), vault.save(enc('c'))]);

    expect(vault.generation).toBe(5n);
    expect(dec((await Vault.open(store, PASS, opts)).plaintext)).toBe('c');
  });

  it('a failed write does not advance the generation', async () => {
    const vault = await createVault();
    vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('disk full'));

    await expect(vault.save(enc('x'))).rejects.toThrow('disk full');
    await vault.save(enc('y'));

    expect(vault.generation).toBe(3n);
  });
});

describe('header tampering', () => {
  it.each([
    ['generation', 12],
    ['kdf params', 20],
    ['salt', -1],
  ])('modified %s → error, no plaintext', async (_field, offset) => {
    await createVault();
    for (const slot of ['A', 'B'] as const) {
      const bytes = slotBytes(slot);
      const kdfLen = new DataView(bytes.buffer, bytes.byteOffset).getUint16(13);
      const i = offset < 0 ? 15 + kdfLen + 3 : offset;
      bytes[i] = (bytes[i] ?? 0) ^ 0x01;
    }

    await expect(Vault.open(store, PASS, opts)).rejects.toThrow(
      /Decryption failed|Invalid KDF header/,
    );
  });

  it('wrong magic → FormatError', () => {
    expect(() => parseVault(new Uint8Array(200))).toThrow(FormatError);
  });

  it('future format version → UnsupportedVersionError', async () => {
    await createVault();
    for (const slot of ['A', 'B'] as const) slotBytes(slot)[4] = VAULT_FORMAT_VERSION + 1;

    await expect(Vault.open(store, PASS, opts)).rejects.toBeInstanceOf(UnsupportedVersionError);
  });

  it('version 0 and absurd KDF length are rejected', async () => {
    await createVault();
    const zero = slotBytes('A').slice();
    zero[4] = 0;
    const longKdf = slotBytes('A').slice();
    new DataView(longKdf.buffer).setUint16(13, 5000);
    const shortKdf = slotBytes('A').slice();
    new DataView(shortKdf.buffer).setUint16(13, 60000);

    expect(() => parseVault(zero)).toThrow(FormatError);
    expect(() => parseVault(longKdf)).toThrow(FormatError);
    expect(() => parseVault(shortKdf.subarray(0, 120))).toThrow(FormatError);
  });
});

describe('KDF downgrade guard', () => {
  it('rejects a vault whose header asks for weaker parameters than the minimum', async () => {
    await createVault();

    await expect(Vault.open(store, PASS, { minKdf: PRODUCTION_KDF_PARAMS })).rejects.toBeInstanceOf(
      KdfPolicyError,
    );
  });

  it('defaults to the production minimum', async () => {
    await createVault();

    await expect(Vault.open(store, PASS)).rejects.toBeInstanceOf(KdfPolicyError);
  });
});

describe('changePassphrase', () => {
  it('re-wraps the DEK: old passphrase fails on every slot, new one works, data unchanged', async () => {
    const vault = await createVault('ledger data');

    await vault.changePassphrase(PASS, 'brand new passphrase', enc('ledger data'));

    await expect(Vault.open(store, PASS, opts)).rejects.toBeInstanceOf(DecryptionError);
    const { plaintext } = await Vault.open(store, 'brand new passphrase', opts);
    expect(dec(plaintext)).toBe('ledger data');
  });

  it('keeps the same DEK (data is not re-encrypted under a new key)', async () => {
    const vault = await createVault('x');
    const before = parseVault(slotBytes('A'));

    await vault.changePassphrase(PASS, 'brand new passphrase', enc('x'));
    const after = parseVault(slotBytes('A'));

    expect(after.salt).not.toEqual(before.salt);
    expect(after.wrappedDek).not.toEqual(before.wrappedDek);
  });

  it('wrong old passphrase → DecryptionError and nothing is written', async () => {
    const vault = await createVault();
    const writes = store.writes;

    await expect(
      vault.changePassphrase('not the passphrase', 'new passphrase 123', enc('x')),
    ).rejects.toBeInstanceOf(DecryptionError);
    expect(store.writes).toBe(writes);
    expect(dec((await Vault.open(store, PASS, opts)).plaintext)).toBe('v1');
  });
});
