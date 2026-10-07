import { PRODUCTION_KDF_PARAMS, type KdfParams } from '@budget/core';
import {
  DecryptionError,
  FormatError,
  UnsupportedVersionError,
  Vault,
  VaultNotFoundError,
} from '@budget/crypto';
import { migrateSqlite, type SqlRow, type SqlValue } from '@budget/db';
import { SqliteWasmDriver } from '@budget/db/sqlite-wasm';
import { expose } from 'comlink';

import { openVaultStore, type FileVaultStore } from './vault-store';
import type {
  DbWorkerApi,
  VaultErrorCode,
  VaultResult,
  VaultStatus,
  WorkerStats,
  WorkerTestConfig,
} from './worker-api';

/*
 * Storage worker (AD5): owns the in-memory SQLite database and the non-extractable DEK. After each
 * committed write it debounces 500 ms, exports the database, encrypts it and writes the next vault
 * slot. The main thread only ever sees query results, never keys.
 */

const DEFAULT_DEBOUNCE_MS = 500;
const MAX_UNLOCK_DELAY_MS = 30_000;

/** Test-only overrides are compiled out of production builds (TEST_PLAN §0 rule 5). */
const TEST_MODE = import.meta.env.MODE === 'test';

function unlockDelayMs(failedAttempts: number): number {
  return failedAttempts === 0 ? 0 : Math.min(1000 * 2 ** (failedAttempts - 1), MAX_UNLOCK_DELAY_MS);
}

function toErrorCode(err: unknown): VaultErrorCode {
  if (err instanceof DecryptionError) return 'WRONG_PASSPHRASE';
  if (err instanceof UnsupportedVersionError) return 'UNSUPPORTED_VERSION';
  if (err instanceof VaultNotFoundError) return 'NO_VAULT';
  if (err instanceof FormatError) return 'CORRUPT';
  return 'STORAGE_FAILED';
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

class DbWorker implements DbWorkerApi {
  #store: FileVaultStore | null = null;
  #forceIndexedDb = false;
  #kdfParams: KdfParams = PRODUCTION_KDF_PARAMS;
  #debounceMs = DEFAULT_DEBOUNCE_MS;
  #vault: Vault | null = null;
  #driver: SqliteWasmDriver | null = null;
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #persisting: Promise<void> = Promise.resolve();
  #failedAttempts = 0;
  #persistWrites = 0;

  configureForTests(config: WorkerTestConfig): Promise<void> {
    if (TEST_MODE) {
      this.#forceIndexedDb = config.forceIndexedDb ?? false;
      this.#kdfParams = config.kdfParams ?? PRODUCTION_KDF_PARAMS;
      this.#debounceMs = config.persistDebounceMs ?? DEFAULT_DEBOUNCE_MS;
      this.#store = null;
    }
    return Promise.resolve();
  }

  async #getStore(): Promise<FileVaultStore> {
    this.#store ??= await openVaultStore({ forceIndexedDb: this.#forceIndexedDb });
    return this.#store;
  }

  #requireDriver(): SqliteWasmDriver {
    if (!this.#driver) throw new Error('LOCKED');
    return this.#driver;
  }

  async status(): Promise<VaultStatus> {
    const store = await this.#getStore();
    return {
      hasVault: await Vault.exists(store),
      unlocked: this.#vault !== null,
      storage: store.kind,
      failedAttempts: this.#failedAttempts,
    };
  }

  async createVault(passphrase: string): Promise<VaultResult> {
    const store = await this.#getStore();
    if (await Vault.exists(store)) return { ok: false, error: 'VAULT_EXISTS' };
    const driver = await SqliteWasmDriver.open();
    try {
      await migrateSqlite(driver);
      this.#vault = await Vault.create(store, passphrase, await driver.export(), {
        kdfParams: this.#kdfParams,
      });
    } catch (err) {
      await driver.close();
      return { ok: false, error: toErrorCode(err) };
    }
    this.#driver = driver;
    this.#failedAttempts = 0;
    return { ok: true };
  }

  async unlock(passphrase: string): Promise<VaultResult> {
    if (this.#vault) return { ok: true };
    await sleep(unlockDelayMs(this.#failedAttempts));
    const store = await this.#getStore();
    let opened: Awaited<ReturnType<typeof Vault.open>>;
    try {
      opened = await Vault.open(store, passphrase, {
        minKdf: TEST_MODE ? this.#kdfParams : PRODUCTION_KDF_PARAMS,
      });
    } catch (err) {
      const error = toErrorCode(err);
      if (error === 'WRONG_PASSPHRASE') this.#failedAttempts++;
      return { ok: false, error, retryAfterMs: unlockDelayMs(this.#failedAttempts) };
    }
    const driver = await SqliteWasmDriver.open(opened.plaintext);
    opened.plaintext.fill(0);
    const applied = await migrateSqlite(driver);
    this.#vault = opened.vault;
    this.#driver = driver;
    this.#failedAttempts = 0;
    if (applied.length > 0) {
      this.#dirty = true;
      await this.flush();
    }
    return { ok: true };
  }

  async lock(): Promise<void> {
    await this.flush();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#driver?.close();
    // Dropping the references releases the non-extractable DEK held by the Vault.
    this.#driver = null;
    this.#vault = null;
  }

  async changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<VaultResult> {
    const vault = this.#vault;
    if (!vault) return { ok: false, error: 'LOCKED' };
    await this.#persisting;
    try {
      const bytes = await this.#requireDriver().export();
      await vault.changePassphrase(oldPassphrase, newPassphrase, bytes);
      this.#dirty = false;
      this.#persistWrites += 2;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: toErrorCode(err) };
    }
  }

  async verifyPassphrase(passphrase: string): Promise<boolean> {
    try {
      await Vault.open(await this.#getStore(), passphrase, {
        minKdf: TEST_MODE ? this.#kdfParams : PRODUCTION_KDF_PARAMS,
      });
      return true;
    } catch {
      return false;
    }
  }

  async exec(sql: string, params: SqlValue[]): Promise<{ changes: number }> {
    const driver = this.#requireDriver();
    const result = await driver.exec(sql, params);
    this.#markDirty(driver);
    return result;
  }

  query(sql: string, params: SqlValue[]): Promise<SqlRow[]> {
    return this.#requireDriver().query(sql, params);
  }

  values(sql: string, params: SqlValue[]): Promise<SqlValue[][]> {
    return this.#requireDriver().values(sql, params);
  }

  async begin(): Promise<void> {
    await this.#requireDriver().exec('BEGIN IMMEDIATE');
  }

  async commit(): Promise<void> {
    const driver = this.#requireDriver();
    await driver.exec('COMMIT');
    this.#markDirty(driver);
  }

  async rollback(): Promise<void> {
    const driver = this.#requireDriver();
    if (!driver.autocommit) await driver.exec('ROLLBACK');
  }

  exportDatabase(): Promise<Uint8Array> {
    return this.#requireDriver().export();
  }

  async saveFile(name: string, bytes: Uint8Array): Promise<void> {
    await (await this.#getStore()).writeFile(name, bytes);
  }

  async readFile(name: string): Promise<Uint8Array | null> {
    return (await this.#getStore()).readFile(name);
  }

  stats(): Promise<WorkerStats> {
    return Promise.resolve({ persistWrites: this.#persistWrites });
  }

  /** Persists now if there are committed, unsaved changes. */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#persisting = this.#persisting.then(() => this.#persist());
    await this.#persisting;
  }

  #markDirty(driver: SqliteWasmDriver): void {
    this.#dirty = true;
    // Only committed state is persisted: inside an open transaction we wait for COMMIT.
    if (!driver.autocommit) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.#debounceMs);
  }

  async #persist(): Promise<void> {
    const vault = this.#vault;
    const driver = this.#driver;
    if (!this.#dirty || !vault || !driver) return;
    if (!driver.autocommit) {
      this.#markDirty(driver);
      return;
    }
    this.#dirty = false;
    try {
      await vault.save(await driver.export());
      this.#persistWrites++;
    } catch {
      // Keep the change pending and retry on the next write or flush. No details are logged.
      this.#dirty = true;
    }
  }
}

expose(new DbWorker());
