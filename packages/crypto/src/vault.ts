import {
  kdfParamsSchema,
  meetsMinimumKdf,
  PRODUCTION_KDF_PARAMS,
  type KdfParams,
} from '@budget/core';

import {
  DecryptionError,
  FormatError,
  KdfPolicyError,
  UnsupportedVersionError,
  VaultNotFoundError,
} from './errors';
import {
  concat,
  decrypt,
  deriveKek,
  encrypt,
  generateDek,
  IV_BYTES,
  randomBytes,
  rewrapDek,
  SALT_BYTES,
  TAG_BYTES,
  unwrapDek,
  wrapDek,
  WRAPPED_DEK_BYTES,
} from './primitives';

/*
 * Local vault file (BUILD_PLAN §4.5):
 *
 *   magic "BGTV" | format_version u8 | generation u64 BE | kdf_len u16 BE | kdf_params JSON |
 *   salt 16B | wrapped_DEK 60B (iv 12 + ct 32 + tag 16) | data_iv 12B | data_ciphertext + tag 16B
 *
 * AAD: the DEK is wrapped with AAD = magic | version | kdf_len | kdf_params | salt (the key header,
 * which does not change between saves). The data is encrypted with AAD = every header byte up to and
 * including wrapped_DEK, so tampering with any header field (generation included) is detected.
 */
export const VAULT_MAGIC = new TextEncoder().encode('BGTV');
export const VAULT_FORMAT_VERSION = 1;
const MAX_KDF_JSON_BYTES = 1024;

export type VaultSlot = 'A' | 'B';
export const VAULT_SLOTS: readonly VaultSlot[] = ['A', 'B'];

/** Storage for the two alternating vault slots (OPFS, IndexedDB, memory in tests). */
export interface VaultStore {
  read(slot: VaultSlot): Promise<Uint8Array | null>;
  write(slot: VaultSlot, data: Uint8Array): Promise<void>;
}

export interface ParsedVault {
  version: number;
  generation: bigint;
  kdfParams: KdfParams;
  salt: Uint8Array;
  wrappedDek: Uint8Array;
  /** AAD used to wrap the DEK. */
  keyAad: Uint8Array;
  /** AAD used to encrypt the data (all header bytes). */
  dataAad: Uint8Array;
  /** data_iv ‖ ciphertext ‖ tag */
  sealedData: Uint8Array;
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n);
  return b;
}

function u64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n);
  return b;
}

function keyHeader(kdfJson: Uint8Array, salt: Uint8Array): Uint8Array {
  return concat(
    VAULT_MAGIC,
    Uint8Array.of(VAULT_FORMAT_VERSION),
    u16(kdfJson.length),
    kdfJson,
    salt,
  );
}

function encodeKdf(params: KdfParams): Uint8Array {
  const p = kdfParamsSchema.parse(params);
  return new TextEncoder().encode(
    JSON.stringify({
      algorithm: p.algorithm,
      memoryKiB: p.memoryKiB,
      iterations: p.iterations,
      parallelism: p.parallelism,
    }),
  );
}

/** Parses and structurally validates a vault file. Throws FormatError / UnsupportedVersionError. */
export function parseVault(bytes: Uint8Array): ParsedVault {
  const minLength = 4 + 1 + 8 + 2 + SALT_BYTES + WRAPPED_DEK_BYTES + IV_BYTES + TAG_BYTES;
  if (bytes.length < minLength) throw new FormatError('Vault file is truncated');
  for (let i = 0; i < VAULT_MAGIC.length; i++) {
    if (bytes[i] !== VAULT_MAGIC[i]) throw new FormatError('Not a vault file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  if (version > VAULT_FORMAT_VERSION)
    throw new UnsupportedVersionError(version, VAULT_FORMAT_VERSION);
  if (version < 1) throw new FormatError('Invalid vault version');
  const generation = view.getBigUint64(5);
  const kdfLen = view.getUint16(13);
  if (kdfLen === 0 || kdfLen > MAX_KDF_JSON_BYTES) throw new FormatError('Invalid KDF header');
  let offset = 15;
  const end = offset + kdfLen + SALT_BYTES + WRAPPED_DEK_BYTES;
  if (bytes.length < end + IV_BYTES + TAG_BYTES) throw new FormatError('Vault file is truncated');
  const kdfJson = bytes.subarray(offset, offset + kdfLen);
  offset += kdfLen;
  let kdfParams: KdfParams;
  try {
    kdfParams = kdfParamsSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(kdfJson)),
    );
  } catch {
    throw new FormatError('Invalid KDF header');
  }
  const salt = bytes.slice(offset, offset + SALT_BYTES);
  offset += SALT_BYTES;
  const wrappedDek = bytes.slice(offset, offset + WRAPPED_DEK_BYTES);
  offset += WRAPPED_DEK_BYTES;
  return {
    version,
    generation,
    kdfParams,
    salt,
    wrappedDek,
    keyAad: keyHeader(kdfJson, salt),
    dataAad: bytes.slice(0, offset),
    sealedData: bytes.slice(offset),
  };
}

interface KeyMaterial {
  dek: CryptoKey;
  kdfParams: KdfParams;
  salt: Uint8Array;
  wrappedDek: Uint8Array;
}

async function sealVault(
  keys: KeyMaterial,
  generation: bigint,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const kdfJson = encodeKdf(keys.kdfParams);
  const header = concat(
    VAULT_MAGIC,
    Uint8Array.of(VAULT_FORMAT_VERSION),
    u64(generation),
    u16(kdfJson.length),
    kdfJson,
    keys.salt,
    keys.wrappedDek,
  );
  return concat(header, await encrypt(keys.dek, plaintext, header));
}

export interface OpenVaultOptions {
  /** Minimum accepted KDF parameters (downgrade guard). Defaults to production parameters. */
  minKdf?: KdfParams;
}

/**
 * An unlocked vault. Holds only the non-extractable DEK and the public key header, never the
 * passphrase or the KEK. Saves alternate between slots A and B with an increasing generation, so a
 * crash mid-write always leaves the previous generation intact.
 */
export class Vault {
  #keys: KeyMaterial;
  #generation: bigint;
  #slot: VaultSlot;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly store: VaultStore,
    keys: KeyMaterial,
    generation: bigint,
    slot: VaultSlot,
  ) {
    this.#keys = keys;
    this.#generation = generation;
    this.#slot = slot;
  }

  get generation(): bigint {
    return this.#generation;
  }

  get kdfParams(): KdfParams {
    return this.#keys.kdfParams;
  }

  /** True when at least one slot has data. */
  static async exists(store: VaultStore): Promise<boolean> {
    for (const slot of VAULT_SLOTS) {
      if (await store.read(slot)) return true;
    }
    return false;
  }

  /** Creates a new vault (fresh DEK and salt) and writes it to both slots. */
  static async create(
    store: VaultStore,
    passphrase: string,
    plaintext: Uint8Array,
    { kdfParams = PRODUCTION_KDF_PARAMS }: { kdfParams?: KdfParams } = {},
  ): Promise<Vault> {
    const salt = randomBytes(SALT_BYTES);
    const kek = await deriveKek(passphrase, salt, kdfParams);
    const aad = keyHeader(encodeKdf(kdfParams), salt);
    const wrappedDek = await wrapDek(await generateDek(), kek, aad);
    // Day-to-day the DEK is held non-extractable; the extractable original is dropped here.
    const dek = await unwrapDek(wrappedDek, kek, aad);
    const vault = new Vault(store, { dek, kdfParams, salt, wrappedDek }, 0n, 'B');
    await vault.save(plaintext);
    await vault.save(plaintext);
    return vault;
  }

  /**
   * Opens the vault: tries the slots from the highest generation down and returns the first that
   * authenticates. Never writes. Fails closed with DecryptionError / FormatError / KdfPolicyError.
   */
  static async open(
    store: VaultStore,
    passphrase: string,
    { minKdf = PRODUCTION_KDF_PARAMS }: OpenVaultOptions = {},
  ): Promise<{ vault: Vault; plaintext: Uint8Array }> {
    const candidates: Array<{ slot: VaultSlot; parsed: ParsedVault }> = [];
    let formatError: FormatError | null = null;
    let found = false;
    for (const slot of VAULT_SLOTS) {
      const bytes = await store.read(slot);
      if (!bytes) continue;
      found = true;
      try {
        candidates.push({ slot, parsed: parseVault(bytes) });
      } catch (err) {
        if (!(err instanceof FormatError)) throw err;
        if (!(formatError instanceof UnsupportedVersionError)) formatError = err;
      }
    }
    if (!found) throw new VaultNotFoundError();

    candidates.sort((a, b) => (a.parsed.generation > b.parsed.generation ? -1 : 1));
    const keks = new Map<string, Promise<CryptoKey>>();
    let attempted = false;
    for (const { slot, parsed } of candidates) {
      if (!meetsMinimumKdf(parsed.kdfParams, minKdf)) {
        formatError ??= new KdfPolicyError();
        continue;
      }
      attempted = true;
      const cacheKey = `${toHex(parsed.salt)}:${JSON.stringify(parsed.kdfParams)}`;
      let kek = keks.get(cacheKey);
      if (!kek) {
        kek = deriveKek(passphrase, parsed.salt, parsed.kdfParams);
        keks.set(cacheKey, kek);
      }
      try {
        const dek = await unwrapDek(parsed.wrappedDek, await kek, parsed.keyAad);
        const plaintext = await decrypt(dek, parsed.sealedData, parsed.dataAad);
        const keys = {
          dek,
          kdfParams: parsed.kdfParams,
          salt: parsed.salt,
          wrappedDek: parsed.wrappedDek,
        };
        return { vault: new Vault(store, keys, parsed.generation, slot), plaintext };
      } catch (err) {
        if (!(err instanceof DecryptionError)) throw err;
      }
    }
    if (!attempted && formatError) throw formatError;
    throw new DecryptionError();
  }

  /** Encrypts `plaintext` as the next generation into the other slot. Calls are serialized. */
  save(plaintext: Uint8Array): Promise<void> {
    const run = this.#queue.then(async () => {
      const generation = this.#generation + 1n;
      const slot: VaultSlot = this.#slot === 'A' ? 'B' : 'A';
      const bytes = await sealVault(this.#keys, generation, plaintext);
      await this.store.write(slot, bytes);
      this.#generation = generation;
      this.#slot = slot;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Re-wraps the DEK under a new passphrase (fresh salt) and writes both slots, so the old
   * passphrase no longer opens any slot. Data is not re-encrypted with a new DEK. Throws
   * DecryptionError when `oldPassphrase` is wrong.
   */
  async changePassphrase(
    oldPassphrase: string,
    newPassphrase: string,
    plaintext: Uint8Array,
    { kdfParams = this.#keys.kdfParams }: { kdfParams?: KdfParams } = {},
  ): Promise<void> {
    const current = this.#keys;
    const oldKek = await deriveKek(oldPassphrase, current.salt, current.kdfParams);
    const salt = randomBytes(SALT_BYTES);
    const newKek = await deriveKek(newPassphrase, salt, kdfParams);
    const wrappedDek = await rewrapDek(
      current.wrappedDek,
      oldKek,
      keyHeader(encodeKdf(current.kdfParams), current.salt),
      newKek,
      keyHeader(encodeKdf(kdfParams), salt),
    );
    this.#keys = { dek: current.dek, kdfParams, salt, wrappedDek };
    await this.save(plaintext);
    await this.save(plaintext);
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** In-memory VaultStore (tests, and a building block for real stores). */
export class MemoryVaultStore implements VaultStore {
  readonly slots = new Map<VaultSlot, Uint8Array>();
  writes = 0;

  read(slot: VaultSlot): Promise<Uint8Array | null> {
    const data = this.slots.get(slot);
    return Promise.resolve(data ? data.slice() : null);
  }

  write(slot: VaultSlot, data: Uint8Array): Promise<void> {
    this.writes++;
    this.slots.set(slot, data.slice());
    return Promise.resolve();
  }
}
