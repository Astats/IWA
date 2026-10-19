import { PRODUCTION_KDF_PARAMS, type KdfParams, type Repositories } from '@budget/core';
import { randomBytes, Vault, type VaultSlot, type VaultStore } from '@budget/crypto';
import { createSqliteRepositories, migrateSqlite, Mutex } from '@budget/db';
import { NativeSqlDriver, type PluginConnection } from '@budget/db/native';

import type { VaultService } from '@/di';

import { assertSafeName, sleep, toErrorCode, unlockDelayMs } from '../vault-common';
import type { VaultResult, VaultStatus } from '../worker-api';

/** The encrypted ledger (SQLCipher) and the plain store for the wrapped key and side files. */
export const DATA_DB = 'budget';
export const META_DB = 'budget-meta';
const SECRET_BYTES = 32;

export interface NativeDatabase {
  conn: PluginConnection;
  close: () => Promise<void>;
  /** Deletes the database file and closes the connection. */
  delete: () => Promise<void>;
}

/**
 * What the native vault needs from `@capacitor-community/sqlite` (see capacitor-sqlite.ts).
 * The plugin can only delete a database it can open, so deleting goes through an open one.
 */
export interface NativeSqlitePort {
  /** The plugin's secure store (Android Keystore / iOS Keychain) holds one SQLCipher secret. */
  isSecretStored(): Promise<boolean>;
  setSecret(secret: string): Promise<void>;
  clearSecret(): Promise<void>;
  /** Opens `name`; encrypted databases use the stored secret as the SQLCipher key. */
  open(name: string, encrypted: boolean): Promise<NativeDatabase>;
}

export interface NativeVaultOptions {
  /** Argon2id parameters for new vaults and passphrase changes. */
  kdfParams?: KdfParams;
  /** Weakest parameters accepted when opening (downgrade guard). */
  minKdf?: KdfParams;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Vault slots and side files in the unencrypted meta database. Only ciphertext goes in. */
class MetaStore implements VaultStore {
  private constructor(private readonly driver: NativeSqlDriver) {}

  static async open(port: NativeSqlitePort): Promise<MetaStore> {
    const db = await port.open(META_DB, false);
    const driver = new NativeSqlDriver(db.conn, db.close);
    await driver.exec(
      'CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)',
    );
    return new MetaStore(driver);
  }

  read(slot: VaultSlot): Promise<Uint8Array | null> {
    return this.readFile(`vault-${slot}`);
  }

  write(slot: VaultSlot, data: Uint8Array): Promise<void> {
    return this.writeFile(`vault-${slot}`, data);
  }

  async readFile(name: string): Promise<Uint8Array | null> {
    assertSafeName(name);
    const rows = await this.driver.query<{ data: string }>(
      'SELECT data FROM files WHERE name = ?',
      [name],
    );
    return rows[0] ? fromBase64(rows[0].data) : null;
  }

  async writeFile(name: string, data: Uint8Array): Promise<void> {
    assertSafeName(name);
    await this.driver.exec(
      'INSERT INTO files (name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data',
      [name, toBase64(data)],
    );
  }
}

interface Session {
  vault: Vault;
  /** The SQLCipher secret; zeroed on lock. */
  secret: Uint8Array;
  driver: NativeSqlDriver;
}

/**
 * Encrypted storage on Android/iOS (BUILD_PLAN 4.2, AD6). The ledger is a SQLCipher database
 * whose 256-bit secret is generated once at random. At rest the secret exists only inside a
 * passphrase vault (Argon2id + AES-GCM, the same format as the web vault). Unlocking unwraps it
 * and hands it to the plugin's Keystore/Keychain-backed secure store, which SQLCipher reads from
 * when the database opens; locking closes the database and clears the secret from that store.
 */
export class NativeVault implements VaultService {
  readonly #port: NativeSqlitePort;
  readonly #kdfParams: KdfParams;
  readonly #minKdf: KdfParams;
  readonly #mutex = new Mutex();
  #meta: Promise<MetaStore> | null = null;
  #session: Session | null = null;
  #failedAttempts = 0;
  #staleSecretChecked = false;

  constructor(port: NativeSqlitePort, options: NativeVaultOptions = {}) {
    this.#port = port;
    this.#kdfParams = options.kdfParams ?? PRODUCTION_KDF_PARAMS;
    this.#minKdf = options.minKdf ?? PRODUCTION_KDF_PARAMS;
  }

  #store(): Promise<MetaStore> {
    this.#meta ??= MetaStore.open(this.#port).catch((err: unknown) => {
      this.#meta = null;
      throw err;
    });
    return this.#meta;
  }

  /** A secret left in the secure store by a session that was killed while unlocked. */
  async #clearStaleSecret(): Promise<void> {
    if (this.#staleSecretChecked || this.#session) return;
    if (await this.#port.isSecretStored()) await this.#port.clearSecret();
    this.#staleSecretChecked = true;
  }

  async #openData(secret: Uint8Array): Promise<NativeSqlDriver> {
    if (await this.#port.isSecretStored()) await this.#port.clearSecret();
    try {
      // The plugin stores the secret before it checks the existing databases, so a failure
      // here can still leave it behind: the catch below clears it.
      await this.#port.setSecret(toHex(secret));
      const db = await this.#port.open(DATA_DB, true);
      const driver = new NativeSqlDriver(db.conn, db.close);
      try {
        await migrateSqlite(driver);
      } catch (err) {
        await driver.close();
        throw err;
      }
      return driver;
    } catch (err) {
      await this.#port.clearSecret().catch(() => undefined);
      throw err;
    }
  }

  status(): Promise<VaultStatus> {
    return this.#mutex.run(async () => {
      const store = await this.#store();
      await this.#clearStaleSecret();
      return {
        hasVault: await Vault.exists(store),
        unlocked: this.#session !== null,
        storage: 'native',
        failedAttempts: this.#failedAttempts,
      };
    });
  }

  createVault(passphrase: string): Promise<VaultResult> {
    return this.#mutex.run(async () => {
      try {
        const store = await this.#store();
        if (await Vault.exists(store)) return { ok: false, error: 'VAULT_EXISTS' };
        // A ledger left without its vault (only if the meta database was deleted on its own) can
        // be neither opened nor deleted through the plugin: opening fails below and reports
        // STORAGE_FAILED until the app's data is cleared.
        const secret = randomBytes(SECRET_BYTES);
        const vault = await Vault.create(store, passphrase, secret, { kdfParams: this.#kdfParams });
        this.#session = { vault, secret, driver: await this.#openData(secret) };
        this.#failedAttempts = 0;
        return { ok: true };
      } catch (err) {
        return { ok: false, error: toErrorCode(err) };
      }
    });
  }

  unlock(passphrase: string): Promise<VaultResult> {
    return this.#mutex.run(async (): Promise<VaultResult> => {
      if (this.#session) return { ok: true };
      await sleep(unlockDelayMs(this.#failedAttempts));
      let opened: Awaited<ReturnType<typeof Vault.open>>;
      try {
        opened = await Vault.open(await this.#store(), passphrase, { minKdf: this.#minKdf });
      } catch (err) {
        const error = toErrorCode(err);
        if (error === 'WRONG_PASSPHRASE') this.#failedAttempts++;
        return { ok: false, error, retryAfterMs: unlockDelayMs(this.#failedAttempts) };
      }
      try {
        const driver = await this.#openData(opened.plaintext);
        this.#session = { vault: opened.vault, secret: opened.plaintext, driver };
      } catch {
        opened.plaintext.fill(0);
        return { ok: false, error: 'STORAGE_FAILED' };
      }
      this.#failedAttempts = 0;
      return { ok: true };
    });
  }

  lock(): Promise<void> {
    return this.#mutex.run(async () => {
      const session = this.#session;
      if (!session) return;
      this.#session = null;
      session.secret.fill(0);
      try {
        await session.driver.close();
      } finally {
        await this.#port.clearSecret();
      }
    });
  }

  changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<VaultResult> {
    return this.#mutex.run(async (): Promise<VaultResult> => {
      const session = this.#session;
      if (!session) return { ok: false, error: 'LOCKED' };
      try {
        // Re-wraps the same secret: the SQLCipher database is not re-keyed.
        await session.vault.changePassphrase(oldPassphrase, newPassphrase, session.secret, {
          kdfParams: this.#kdfParams,
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: toErrorCode(err) };
      }
    });
  }

  async verifyPassphrase(passphrase: string): Promise<boolean> {
    try {
      const opened = await Vault.open(await this.#store(), passphrase, { minKdf: this.#minKdf });
      opened.plaintext.fill(0);
      return true;
    } catch {
      return false;
    }
  }

  /** SQLite commits are durable on the device; nothing is pending. */
  flush(): Promise<void> {
    return Promise.resolve();
  }

  async saveFile(name: string, bytes: Uint8Array): Promise<void> {
    await (await this.#store()).writeFile(name, bytes);
  }

  async readFile(name: string): Promise<Uint8Array | null> {
    return (await this.#store()).readFile(name);
  }

  createRepositories(): Repositories {
    if (!this.#session) throw new Error('The vault is locked');
    return createSqliteRepositories(this.#session.driver);
  }

  /** App data on Android/iOS is not evicted like browser storage. */
  requestPersistentStorage(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
