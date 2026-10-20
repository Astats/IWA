import { PRODUCTION_KDF_PARAMS, type KdfParams, type Repositories } from '@budget/core';
import { randomBytes, Vault, type VaultSlot, type VaultStore } from '@budget/crypto';
import { createSqliteRepositories, migrateSqlite, Mutex } from '@budget/db';
import { NativeSqlDriver, type PluginConnection } from '@budget/db/native';

import type {
  BiometricErrorCode,
  BiometricPromptText,
  BiometricResult,
  BiometricUnlock,
  VaultService,
} from '@/di';
import { base64ToBytes, bytesToBase64 } from '@/lib/base64';

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
  /**
   * The plugin's secure store (Android Keystore / iOS Keychain) holds one SQLCipher secret.
   * `setSecret` and `clearSecret` close every open database, like the plugin does.
   */
  isSecretStored(): Promise<boolean>;
  setSecret(secret: string): Promise<void>;
  clearSecret(): Promise<void>;
  /** Opens `name`; encrypted databases use the stored secret as the SQLCipher key. */
  open(name: string, encrypted: boolean): Promise<NativeDatabase>;
}

/** Why reading the biometric-protected key failed (see capacitor-biometric.ts). */
export class BiometricKeyError extends Error {
  constructor(readonly reason: BiometricErrorCode | 'MISSING') {
    super(`Biometric key: ${reason}`);
    this.name = 'BiometricKeyError';
  }
}

/**
 * A key store whose entry only a successful strong-biometric check releases (Android Keystore
 * key bound to BiometricPrompt via CryptoObject; iOS Keychain item with biometric access
 * control). Invalidated when the enrolled biometrics change.
 */
export interface BiometricKeyPort {
  isAvailable(): Promise<boolean>;
  isStored(): Promise<boolean>;
  store(value: string): Promise<void>;
  /** Shows the system prompt; rejects with BiometricKeyError. */
  read(prompt: BiometricPromptText): Promise<string>;
  remove(): Promise<void>;
}

export interface NativeVaultOptions {
  /** Argon2id parameters for new vaults and passphrase changes. */
  kdfParams?: KdfParams;
  /** Weakest parameters accepted when opening (downgrade guard). */
  minKdf?: KdfParams;
  /** Biometric unlock (BUILD_PLAN 4.3); without it the vault offers none. */
  biometrics?: BiometricKeyPort;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

/**
 * Vault slots and side files in the unencrypted meta database. Only ciphertext goes in. The
 * connection opens on first use and again after `reconnect()`: the plugin closes every database
 * whenever the secret is set or cleared.
 */
class MetaStore implements VaultStore {
  #driver: Promise<NativeSqlDriver> | null = null;

  constructor(private readonly port: NativeSqlitePort) {}

  #db(): Promise<NativeSqlDriver> {
    this.#driver ??= (async () => {
      const db = await this.port.open(META_DB, false);
      const driver = new NativeSqlDriver(db.conn, db.close);
      await driver.exec(
        'CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)',
      );
      return driver;
    })().catch((err: unknown) => {
      this.#driver = null;
      throw err;
    });
    return this.#driver;
  }

  /** The plugin closed the connection; the next access opens a new one. */
  reconnect(): void {
    this.#driver = null;
  }

  read(slot: VaultSlot): Promise<Uint8Array | null> {
    return this.readFile(`vault-${slot}`);
  }

  write(slot: VaultSlot, data: Uint8Array): Promise<void> {
    return this.writeFile(`vault-${slot}`, data);
  }

  async readFile(name: string): Promise<Uint8Array | null> {
    assertSafeName(name);
    const rows = await (await this.#db()).query<{ data: string }>(
      'SELECT data FROM files WHERE name = ?',
      [name],
    );
    return rows[0] ? base64ToBytes(rows[0].data) : null;
  }

  async writeFile(name: string, data: Uint8Array): Promise<void> {
    assertSafeName(name);
    await (await this.#db()).exec(
      'INSERT INTO files (name, data) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data',
      [name, bytesToBase64(data)],
    );
  }
}

interface Session {
  /** Null after a biometric unlock (no passphrase was entered); opened on demand. */
  vault: Vault | null;
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
  readonly #meta: MetaStore;
  #session: Session | null = null;
  #failedAttempts = 0;
  #staleSecretChecked = false;
  readonly #biometricKeys: BiometricKeyPort | undefined;
  readonly biometrics?: BiometricUnlock;

  constructor(port: NativeSqlitePort, options: NativeVaultOptions = {}) {
    this.#port = port;
    this.#meta = new MetaStore(port);
    this.#kdfParams = options.kdfParams ?? PRODUCTION_KDF_PARAMS;
    this.#minKdf = options.minKdf ?? PRODUCTION_KDF_PARAMS;
    this.#biometricKeys = options.biometrics;
    if (options.biometrics) this.biometrics = this.#biometricUnlock(options.biometrics);
  }

  /**
   * Biometric unlock stores a second copy of the SQLCipher secret behind the biometric key; the
   * passphrase vault is unchanged, so the passphrase keeps working. Turning it on needs the
   * passphrase (re-authentication); a failed or cancelled prompt never counts as a wrong
   * passphrase, and the system rate-limits biometric attempts itself.
   */
  #biometricUnlock(keys: BiometricKeyPort): BiometricUnlock {
    return {
      isAvailable: () => keys.isAvailable().catch(() => false),
      isEnabled: () => keys.isStored().catch(() => false),
      enable: (passphrase) =>
        this.#mutex.run(async (): Promise<VaultResult> => {
          const session = this.#session;
          if (!session) return { ok: false, error: 'LOCKED' };
          try {
            const opened = await Vault.open(await this.#store(), passphrase, {
              minKdf: this.#minKdf,
            });
            opened.plaintext.fill(0);
          } catch (err) {
            return { ok: false, error: toErrorCode(err) };
          }
          try {
            await keys.store(toHex(session.secret));
            return { ok: true };
          } catch {
            return { ok: false, error: 'STORAGE_FAILED' };
          }
        }),
      disable: () => keys.remove(),
      unlock: (prompt) =>
        this.#mutex.run(async (): Promise<BiometricResult> => {
          if (this.#session) return { ok: true };
          let secret: Uint8Array;
          try {
            const hex = await keys.read(prompt);
            if (!/^[0-9a-f]{64}$/.test(hex)) throw new BiometricKeyError('INVALIDATED');
            secret = fromHex(hex);
          } catch (err) {
            const reason = err instanceof BiometricKeyError ? err.reason : 'FAILED';
            if (reason !== 'INVALIDATED' && reason !== 'MISSING')
              return { ok: false, error: reason };
            await keys.remove().catch(() => undefined);
            return { ok: false, error: 'INVALIDATED' };
          }
          try {
            const driver = await this.#openData(secret);
            this.#session = { vault: null, secret, driver };
          } catch {
            // A key that does not open the ledger is useless: fall back to the passphrase.
            secret.fill(0);
            await keys.remove().catch(() => undefined);
            return { ok: false, error: 'INVALIDATED' };
          }
          this.#failedAttempts = 0;
          return { ok: true };
        }),
    };
  }

  #store(): Promise<MetaStore> {
    return Promise.resolve(this.#meta);
  }

  /** Setting or clearing the secret closes every open database (plugin behaviour). */
  async #setSecret(secret: string): Promise<void> {
    try {
      await this.#port.setSecret(secret);
    } finally {
      this.#meta.reconnect();
    }
  }

  async #clearSecret(): Promise<void> {
    try {
      await this.#port.clearSecret();
    } finally {
      this.#meta.reconnect();
    }
  }

  /** A secret left in the secure store by a session that was killed while unlocked. */
  async #clearStaleSecret(): Promise<void> {
    if (this.#staleSecretChecked || this.#session) return;
    if (await this.#port.isSecretStored()) await this.#clearSecret();
    this.#staleSecretChecked = true;
  }

  async #openData(secret: Uint8Array): Promise<NativeSqlDriver> {
    if (await this.#port.isSecretStored()) await this.#clearSecret();
    try {
      // The plugin stores the secret before it checks the existing databases, so a failure
      // here can still leave it behind: the catch below clears it.
      await this.#setSecret(toHex(secret));
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
      await this.#clearSecret().catch(() => undefined);
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
        // A biometric key can only belong to an earlier vault on this device.
        await this.#biometricKeys?.remove().catch(() => undefined);
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
        await this.#clearSecret();
      }
    });
  }

  changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<VaultResult> {
    return this.#mutex.run(async (): Promise<VaultResult> => {
      const session = this.#session;
      if (!session) return { ok: false, error: 'LOCKED' };
      try {
        // After a biometric unlock the vault is opened here, which also checks oldPassphrase.
        let vault = session.vault;
        if (!vault) {
          const opened = await Vault.open(await this.#store(), oldPassphrase, {
            minKdf: this.#minKdf,
          });
          opened.plaintext.fill(0);
          vault = session.vault = opened.vault;
        }
        // Re-wraps the same secret: the SQLCipher database is not re-keyed, so a biometric
        // key stays valid.
        await vault.changePassphrase(oldPassphrase, newPassphrase, session.secret, {
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
