import { testKdfParams } from '@budget/core/testing';
import { FakePluginConnection } from '@budget/db/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DATA_DB, META_DB, NativeVault, type NativeSqlitePort } from './native-vault';

const PASSPHRASE = 'tulip river quiet lamp 2026';

/**
 * In-memory stand-in for the plugin: databases survive "restarts" (new NativeVault instances),
 * and an encrypted database only opens with the secret it was created with — like SQLCipher.
 */
class FakePort implements NativeSqlitePort {
  secret: string | null = null;
  secretWrites: string[] = [];
  readonly dbs = new Map<string, { key: string | null; conn: FakePluginConnection }>();
  failOpen: string | null = null;
  /** Like the plugin when another database cannot be opened: stores the secret, then throws. */
  failSetAfterStore = false;

  isSecretStored = vi.fn(() => Promise.resolve(this.secret !== null));
  setSecret = vi.fn((secret: string) => {
    if (this.secret !== null) return Promise.reject(new Error('a passphrase has already been set'));
    this.secret = secret;
    this.secretWrites.push(secret);
    if (this.failSetAfterStore) return Promise.reject(new Error('State for: x not correct'));
    return Promise.resolve();
  });
  clearSecret = vi.fn(() => {
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
    return {
      conn: db.conn,
      close: () => Promise.resolve(),
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
