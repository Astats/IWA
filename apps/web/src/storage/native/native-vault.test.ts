import { testKdfParams } from '@budget/core/testing';
import { FakePluginConnection } from '@budget/db/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BiometricPromptText } from '@/di';

import {
  BiometricKeyError,
  DATA_DB,
  META_DB,
  NativeVault,
  type BiometricKeyPort,
  type NativeSqlitePort,
} from './native-vault';

const PASSPHRASE = 'tulip river quiet lamp 2026';

/**
 * In-memory stand-in for the plugin: databases survive "restarts" (new NativeVault instances),
 * and an encrypted database only opens with the secret it was created with — like SQLCipher.
 * Like the plugin, setting or clearing the secret closes every open connection.
 */
class FakePort implements NativeSqlitePort {
  secret: string | null = null;
  secretWrites: string[] = [];
  readonly dbs = new Map<string, { key: string | null; conn: FakePluginConnection }>();
  failOpen: string | null = null;
  /** Like the plugin when another database cannot be opened: stores the secret, then throws. */
  failSetAfterStore = false;
  readonly #open = new Set<{ closed: boolean }>();

  #closeAll() {
    for (const handle of this.#open) handle.closed = true;
    this.#open.clear();
  }

  isSecretStored = vi.fn(() => Promise.resolve(this.secret !== null));
  setSecret = vi.fn((secret: string) => {
    this.#closeAll();
    if (this.secret !== null) return Promise.reject(new Error('a passphrase has already been set'));
    this.secret = secret;
    this.secretWrites.push(secret);
    if (this.failSetAfterStore) return Promise.reject(new Error('State for: x not correct'));
    return Promise.resolve();
  });
  clearSecret = vi.fn(() => {
    this.#closeAll();
    this.secret = null;
    return Promise.resolve();
  });
  async open(name: string, encrypted: boolean) {
    if (this.failOpen === name) throw new Error('open failed');
    const key = encrypted ? this.secret : null;
    if (encrypted && key === null) throw new Error('no secret stored');
    let db = this.dbs.get(name);
    if (!db) {
      db = { key, conn: await FakePluginConnection.open() };
      this.dbs.set(name, db);
    } else if (db.key !== key) {
      throw new Error('file is not a database');
    }
    const handle = { closed: false };
    this.#open.add(handle);
    const conn = new Proxy(db.conn, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): unknown =>
          handle.closed
            ? Promise.reject(new Error(`No available connection for database ${name}`))
            : (value as (...a: unknown[]) => unknown).apply(target, args);
      },
    });
    return {
      conn,
      close: () => {
        handle.closed = true;
        this.#open.delete(handle);
        return Promise.resolve();
      },
      delete: () => {
        this.dbs.delete(name);
        return Promise.resolve();
      },
    };
  }
}

const options = { kdfParams: testKdfParams, minKdf: testKdfParams };
let port: FakePort;
const newVault = () => new NativeVault(port, options);

beforeEach(() => {
  port = new FakePort();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NativeVault', () => {
  it('creates an encrypted ledger and reports native storage', async () => {
    const vault = newVault();

    expect(await vault.status()).toEqual({
      hasVault: false,
      unlocked: false,
      storage: 'native',
      failedAttempts: 0,
    });
    expect(await vault.createVault(PASSPHRASE)).toEqual({ ok: true });
    expect(await vault.status()).toMatchObject({ hasVault: true, unlocked: true });
    expect(port.dbs.get(DATA_DB)?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(await vault.createVault(PASSPHRASE)).toEqual({ ok: false, error: 'VAULT_EXISTS' });
  });

  it('keeps data across locks and restarts', async () => {
    const vault = newVault();
    await vault.createVault(PASSPHRASE);
    await vault.createRepositories().categories.create({
      name: 'Food',
      kind: 'expense',
      color: '#ff0000',
      icon: 'utensils',
    });
    await vault.lock();

    const restarted = newVault();
    expect(await restarted.status()).toMatchObject({ hasVault: true, unlocked: false });
    expect(await restarted.unlock(PASSPHRASE)).toEqual({ ok: true });
    const names = (await restarted.createRepositories().categories.list()).map((c) => c.name);
    expect(names).toContain('Food');
  });

  it('holds the SQLCipher secret in the secure store only while unlocked', async () => {
    const vault = newVault();
    await vault.createVault(PASSPHRASE);
    const secret = port.secret;

    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    await vault.lock();
    expect(port.secret).toBeNull();
    expect(() => vault.createRepositories()).toThrow(/locked/);

    // At rest the secret exists only inside the passphrase vault (ciphertext).
    const meta = port.dbs.get(META_DB)?.conn.db;
    const rows = (await meta?.query<{ data: string }>('SELECT data FROM files')) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const { data } of rows) {
      expect(atob(data)).not.toContain(secret);
      expect(Buffer.from(data, 'base64').toString('hex')).not.toContain(secret);
    }

    await vault.unlock(PASSPHRASE);
    expect(port.secret).toBe(secret);
  });

  it('locks and unlocks again in the same process (the plugin closes the meta database)', async () => {
    const vault = newVault();
    await vault.createVault(PASSPHRASE);
    await vault.saveFile('side.bin', new Uint8Array([1, 2]));
    await vault.lock();

    expect(await vault.unlock(PASSPHRASE)).toEqual({ ok: true });
    expect(await vault.readFile('side.bin')).toEqual(new Uint8Array([1, 2]));
    expect(await vault.changePassphrase(PASSPHRASE, 'meadow copper violin 2027')).toEqual({
      ok: true,
    });
    await vault.lock();
    expect(await vault.status()).toMatchObject({ hasVault: true, unlocked: false });
    expect(await vault.unlock('meadow copper violin 2027')).toEqual({ ok: true });
  });

  it('rejects a wrong passphrase with a growing delay and never sets the secret', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true });
    const vault = newVault();
    await vault.createVault(PASSPHRASE);
    await vault.lock();
    port.secretWrites = [];

    expect(await vault.unlock('wrong passphrase 1234')).toEqual({
      ok: false,
      error: 'WRONG_PASSPHRASE',
      retryAfterMs: 1000,
    });
    const second = vault.unlock('wrong passphrase 1234');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await second).toMatchObject({ error: 'WRONG_PASSPHRASE', retryAfterMs: 2000 });
    expect(await vault.status()).toMatchObject({ unlocked: false, failedAttempts: 2 });
    expect(port.secretWrites).toEqual([]);
    expect(await vault.verifyPassphrase('wrong passphrase 1234')).toBe(false);
    expect(await vault.verifyPassphrase(PASSPHRASE)).toBe(true);
  });

  it('clears a secret left behind by a session that was killed while unlocked', async () => {
    const vault = newVault();
    await vault.createVault(PASSPHRASE);

    const afterKill = newVault();
    expect(await afterKill.status()).toMatchObject({ unlocked: false });
    expect(port.secret).toBeNull();
    expect(await afterKill.unlock(PASSPHRASE)).toEqual({ ok: true });
  });

  it('changes the passphrase without re-keying the ledger', async () => {
    const vault = newVault();
    await vault.createVault(PASSPHRASE);
    const key = port.dbs.get(DATA_DB)?.key;

    expect(await vault.changePassphrase('not the passphrase', 'new passphrase 2026')).toEqual({
      ok: false,
      error: 'WRONG_PASSPHRASE',
    });
    expect(await vault.changePassphrase(PASSPHRASE, 'new passphrase 2026')).toEqual({ ok: true });
    await vault.lock();

    const restarted = newVault();
    expect(await restarted.unlock(PASSPHRASE)).toMatchObject({ error: 'WRONG_PASSPHRASE' });
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true });
    const unlocked = restarted.unlock('new passphrase 2026');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await unlocked).toEqual({ ok: true });
    expect(port.dbs.get(DATA_DB)?.key).toBe(key);
  });

  it('refuses to change the passphrase while locked', async () => {
    expect(await newVault().changePassphrase(PASSPHRASE, 'x')).toEqual({
      ok: false,
      error: 'LOCKED',
    });
  });

  it('reports a storage failure for a ledger without its vault and keeps no secret', async () => {
    port.dbs.set(DATA_DB, { key: 'f'.repeat(64), conn: await FakePluginConnection.open() });

    expect(await newVault().createVault(PASSPHRASE)).toEqual({
      ok: false,
      error: 'STORAGE_FAILED',
    });
    expect(port.secret).toBeNull();
  });

  it('reports a storage failure and clears the secret when the ledger cannot open', async () => {
    const vault = newVault();
    await vault.createVault(PASSPHRASE);
    await vault.lock();
    port.failOpen = DATA_DB;

    expect(await vault.unlock(PASSPHRASE)).toEqual({ ok: false, error: 'STORAGE_FAILED' });
    expect(port.secret).toBeNull();
    expect(await vault.status()).toMatchObject({ unlocked: false, failedAttempts: 0 });
  });

  it('clears the secret when the plugin stores it but then fails', async () => {
    const vault = newVault();
    await vault.createVault(PASSPHRASE);
    await vault.lock();
    port.failSetAfterStore = true;

    expect(await vault.unlock(PASSPHRASE)).toEqual({ ok: false, error: 'STORAGE_FAILED' });
    expect(port.secret).toBeNull();
  });

  it('stores side files next to the vault and rejects unsafe names', async () => {
    const vault = newVault();
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 251);

    await vault.saveFile('pre-restore.bgtb', bytes);

    expect(await vault.readFile('pre-restore.bgtb')).toEqual(bytes);
    expect(await vault.readFile('missing.bgtb')).toBeNull();
    await expect(vault.saveFile('../escape', bytes)).rejects.toThrow(/Invalid file name/);
  });

  it('needs no flush and treats native storage as persistent', async () => {
    const vault = newVault();

    await expect(vault.flush()).resolves.toBeUndefined();
    expect(await vault.requestPersistentStorage()).toBe(true);
  });
});

/** The biometric key store: `read` releases the value only when the "user" passes the prompt. */
class FakeBiometricKeys implements BiometricKeyPort {
  available = true;
  value: string | null = null;
  /** What the next prompt does: release the value, or fail with this reason. */
  outcome: 'pass' | BiometricKeyError['reason'] = 'pass';

  isAvailable = vi.fn(() => Promise.resolve(this.available));
  isStored = vi.fn(() => Promise.resolve(this.value !== null));
  store = vi.fn((value: string) => {
    this.value = value;
    return Promise.resolve();
  });
  read = vi.fn((_prompt: BiometricPromptText) => {
    if (this.value === null) return Promise.reject(new BiometricKeyError('MISSING'));
    if (this.outcome !== 'pass') return Promise.reject(new BiometricKeyError(this.outcome));
    return Promise.resolve(this.value);
  });
  remove = vi.fn(() => {
    this.value = null;
    return Promise.resolve();
  });
}

describe('NativeVault biometric unlock (BUILD_PLAN 4.3)', () => {
  const prompt = { title: 'Unlock Budget', cancel: 'Use passphrase' };
  let keys: FakeBiometricKeys;
  const newBioVault = () => new NativeVault(port, { ...options, biometrics: keys });

  beforeEach(() => {
    keys = new FakeBiometricKeys();
  });

  async function enabledAndLocked() {
    const vault = newBioVault();
    await vault.createVault(PASSPHRASE);
    expect(await vault.biometrics?.enable(PASSPHRASE)).toEqual({ ok: true });
    await vault.lock();
    return vault;
  }

  it('is only offered when the vault has a biometric key port', () => {
    expect(newVault().biometrics).toBeUndefined();
    expect(newBioVault().biometrics).toBeDefined();
  });

  it('needs the unlocked vault and the right passphrase to turn on', async () => {
    const vault = newBioVault();
    expect(await vault.biometrics?.enable(PASSPHRASE)).toEqual({ ok: false, error: 'LOCKED' });

    await vault.createVault(PASSPHRASE);
    expect(await vault.biometrics?.enable('wrong passphrase 123')).toEqual({
      ok: false,
      error: 'WRONG_PASSPHRASE',
    });
    expect(keys.store).not.toHaveBeenCalled();
    expect(await vault.biometrics?.isEnabled()).toBe(false);

    expect(await vault.biometrics?.enable(PASSPHRASE)).toEqual({ ok: true });
    expect(await vault.biometrics?.isEnabled()).toBe(true);
    expect(keys.value).toBe(port.dbs.get(DATA_DB)?.key);
  });

  it('unlocks with the biometric key after a restart and the passphrase still works', async () => {
    await enabledAndLocked();
    const restarted = newBioVault();

    expect(await restarted.biometrics?.unlock(prompt)).toEqual({ ok: true });
    expect(keys.read).toHaveBeenCalledWith(prompt);
    expect(await restarted.status()).toMatchObject({ unlocked: true, failedAttempts: 0 });
    await restarted.lock();
    expect(port.secret).toBeNull();
    expect(await restarted.unlock(PASSPHRASE)).toEqual({ ok: true });
  });

  it.each(['CANCELLED', 'LOCKED_OUT', 'FAILED'] as const)(
    'stays locked and keeps the key when the prompt ends with %s',
    async (reason) => {
      const vault = await enabledAndLocked();
      keys.outcome = reason;

      expect(await vault.biometrics?.unlock(prompt)).toEqual({ ok: false, error: reason });
      expect(await vault.status()).toMatchObject({ unlocked: false, failedAttempts: 0 });
      expect(keys.value).not.toBeNull();
      expect(port.secret).toBeNull();
    },
  );

  it('turns itself off when the key was invalidated or is missing', async () => {
    const vault = await enabledAndLocked();
    keys.outcome = 'INVALIDATED';

    expect(await vault.biometrics?.unlock(prompt)).toEqual({ ok: false, error: 'INVALIDATED' });
    expect(await vault.biometrics?.isEnabled()).toBe(false);
    expect(await vault.biometrics?.unlock(prompt)).toEqual({ ok: false, error: 'INVALIDATED' });
    expect(await vault.unlock(PASSPHRASE)).toEqual({ ok: true });
  });

  it('turns itself off when the released value does not open the ledger', async () => {
    const vault = await enabledAndLocked();
    keys.value = 'ab'.repeat(32);

    expect(await vault.biometrics?.unlock(prompt)).toEqual({ ok: false, error: 'INVALIDATED' });
    expect(keys.value).toBeNull();
    expect(port.secret).toBeNull();

    keys.value = 'not hex';
    expect(await vault.biometrics?.unlock(prompt)).toEqual({ ok: false, error: 'INVALIDATED' });
  });

  it('changes the passphrase after a biometric unlock only with the old passphrase', async () => {
    const vault = await enabledAndLocked();
    await vault.biometrics?.unlock(prompt);
    const next = 'meadow copper violin 2027';

    expect(await vault.changePassphrase('wrong passphrase 123', next)).toEqual({
      ok: false,
      error: 'WRONG_PASSPHRASE',
    });
    expect(await vault.changePassphrase(PASSPHRASE, next)).toEqual({ ok: true });
    await vault.lock();

    expect(await vault.unlock(PASSPHRASE)).toMatchObject({ ok: false });
    expect(await vault.biometrics?.unlock(prompt)).toEqual({ ok: true });
    await vault.lock();
    expect(await vault.unlock(next)).toEqual({ ok: true });
  });

  it('can be turned off, and a new vault removes a key left from an earlier one', async () => {
    const vault = newBioVault();
    await vault.createVault(PASSPHRASE);
    await vault.biometrics?.enable(PASSPHRASE);
    await vault.biometrics?.disable();
    expect(await vault.biometrics?.isEnabled()).toBe(false);

    keys.value = 'cd'.repeat(32);
    port = new FakePort();
    await new NativeVault(port, { ...options, biometrics: keys }).createVault(PASSPHRASE);
    expect(keys.value).toBeNull();
  });

  it('reports biometrics as unavailable when the check fails', async () => {
    keys.isAvailable.mockRejectedValueOnce(new Error('no hardware'));

    expect(await newBioVault().biometrics?.isAvailable()).toBe(false);
  });
});
