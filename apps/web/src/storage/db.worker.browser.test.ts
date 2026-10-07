import { PRODUCTION_KDF_PARAMS } from '@budget/core';
import { testKdfParams } from '@budget/core/testing';
import type { Remote } from 'comlink';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanStorageForPlaintext } from './storage-scan';

import { createWorkerRepositories, startDbWorker, type DbWorkerApi } from '.';

const PASS = 'correct horse battery staple 42';
const MARKER = 'MARKER-NOTE-7f3a9c';

let workers: Array<() => void> = [];

async function newWorker(config: { forceIndexedDb?: boolean; persistDebounceMs?: number } = {}) {
  const { api, terminate } = startDbWorker();
  workers.push(terminate);
  await api.configureForTests({ kdfParams: testKdfParams, ...config });
  return { api, terminate };
}

async function clearOrigin(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
    await root.removeEntry(name, { recursive: true });
  }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('budget-vault');
    req.onsuccess =
      req.onerror =
      req.onblocked =
        () => {
          resolve();
        };
  });
}

async function addMarkerTransaction(api: Remote<DbWorkerApi>, note = MARKER) {
  const repos = createWorkerRepositories(api);
  await repos.categories.seedDefaults();
  const [category] = await repos.categories.list({ kind: 'expense' });
  return repos.transactions.create({
    kind: 'expense',
    amountMinor: 4200,
    currency: 'EUR',
    categoryId: category!.id,
    date: '2026-03-15',
    note,
  });
}

beforeEach(async () => {
  await clearOrigin();
});

afterEach(() => {
  for (const terminate of workers) terminate();
  workers = [];
});

for (const storage of ['opfs', 'indexeddb'] as const) {
  describe(`storage worker (${storage})`, () => {
    const config = { forceIndexedDb: storage === 'indexeddb' };

    it('create vault → write → new worker → unlock → data present', async () => {
      const first = await newWorker(config);
      expect(await first.api.status()).toMatchObject({ hasVault: false, unlocked: false, storage });
      expect(await first.api.createVault(PASS)).toEqual({ ok: true });
      const created = await addMarkerTransaction(first.api);
      await first.api.lock();
      first.terminate();

      const second = await newWorker(config);
      expect(await second.api.status()).toMatchObject({ hasVault: true, unlocked: false });
      expect(await second.api.unlock(PASS)).toEqual({ ok: true });
      const repos = createWorkerRepositories(second.api);

      expect(await repos.transactions.get(created.id)).toMatchObject({
        note: MARKER,
        amountMinor: 4200,
      });
    });

    it('stored bytes contain no plaintext (SEC-W03)', async () => {
      const { api } = await newWorker(config);
      await api.createVault(PASS);
      await addMarkerTransaction(api);
      await api.flush();

      const findings = await scanStorageForPlaintext([MARKER, 'Housing', 'CREATE TABLE']);

      expect(findings.scannedBytes).toBeGreaterThan(0);
      expect(findings.matches).toEqual([]);
    });

    it('wrong passphrase → generic error, nothing decrypted, delay grows', async () => {
      const first = await newWorker(config);
      await first.api.createVault(PASS);
      await first.api.lock();
      const { api } = await newWorker(config);

      const r1 = await api.unlock('not the passphrase');

      expect(r1).toEqual({ ok: false, error: 'WRONG_PASSPHRASE', retryAfterMs: 1000 });
      expect(await api.status()).toMatchObject({ unlocked: false, failedAttempts: 1 });
      await expect(api.query('SELECT 1', [])).rejects.toThrow();
      const r2 = await api.unlock('still wrong');
      expect(r2).toMatchObject({ ok: false, retryAfterMs: 2000 });
      expect(await api.unlock(PASS)).toEqual({ ok: true });
      expect((await api.status()).failedAttempts).toBe(0);
    });
  });
}

describe('persistence', () => {
  it('debounces: 20 writes in quick succession → at most 2 vault writes', async () => {
    const { api } = await newWorker({ persistDebounceMs: 200 });
    await api.createVault(PASS);
    const repos = createWorkerRepositories(api);
    await repos.categories.seedDefaults();
    await api.flush();
    const before = (await api.stats()).persistWrites;

    for (let i = 0; i < 20; i++) await repos.settings.set('autoLockMinutes', (i % 10) + 1);
    await new Promise((r) => setTimeout(r, 600));

    const writes = (await api.stats()).persistWrites - before;
    expect(writes).toBeGreaterThanOrEqual(1);
    expect(writes).toBeLessThanOrEqual(2);
  });

  it('lock() flushes pending changes immediately', async () => {
    const { api } = await newWorker({ persistDebounceMs: 60_000 });
    await api.createVault(PASS);
    await addMarkerTransaction(api, 'flushed on lock');

    await api.lock();
    const second = await newWorker();
    await second.api.unlock(PASS);

    expect(
      (await createWorkerRepositories(second.api).transactions.list({ search: 'flushed on lock' }))
        .total,
    ).toBe(1);
  });

  it('a transaction is persisted only after commit; a rollback persists nothing', async () => {
    const { api } = await newWorker({ persistDebounceMs: 50 });
    await api.createVault(PASS);
    const repos = createWorkerRepositories(api);
    await repos.categories.seedDefaults();
    await api.flush();
    const before = (await api.stats()).persistWrites;

    await expect(
      repos.transactions.bulkInsert([
        {
          kind: 'expense',
          amountMinor: -1,
          currency: 'EUR',
          categoryId: '0192f0c1-7a3b-7c3d-8e4f-000000000000',
          date: '2026-01-01',
          note: '',
        },
      ]),
    ).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 200));

    expect((await api.stats()).persistWrites).toBe(before);
  });

  it('crash safety: terminating the worker mid-write still unlocks a consistent generation', async () => {
    const { api, terminate } = await newWorker({ persistDebounceMs: 60_000 });
    await api.createVault(PASS);
    await addMarkerTransaction(api, 'before crash');
    await api.flush();
    await addMarkerTransaction(api, 'during crash');

    void api.flush();
    terminate();
    const second = await newWorker();

    expect(await second.api.unlock(PASS)).toEqual({ ok: true });
    const notes = (await createWorkerRepositories(second.api).transactions.list({})).items.map(
      (t) => t.note,
    );
    expect(notes).toContain('before crash');
  });

  it('changePassphrase: old passphrase fails, new one works, data intact', async () => {
    const { api } = await newWorker();
    await api.createVault(PASS);
    await addMarkerTransaction(api);

    expect(await api.changePassphrase('wrong old passphrase', 'new passphrase 2026')).toEqual({
      ok: false,
      error: 'WRONG_PASSPHRASE',
    });
    expect(await api.changePassphrase(PASS, 'new passphrase 2026')).toEqual({ ok: true });
    expect(await api.verifyPassphrase(PASS)).toBe(false);
    expect(await api.verifyPassphrase('new passphrase 2026')).toBe(true);
    await api.lock();
    const second = await newWorker();
    expect(await second.api.unlock(PASS)).toMatchObject({ ok: false });
    expect(await second.api.unlock('new passphrase 2026')).toEqual({ ok: true });
  });

  it('refuses to create a second vault', async () => {
    const { api } = await newWorker();
    await api.createVault(PASS);

    expect(await api.createVault('another passphrase')).toEqual({
      ok: false,
      error: 'VAULT_EXISTS',
    });
  });

  it('side files (pre-restore backup) round-trip and reject unsafe names', async () => {
    const { api } = await newWorker();

    await api.saveFile('pre-restore.bgtb', Uint8Array.of(1, 2, 3));

    expect(await api.readFile('pre-restore.bgtb')).toEqual(Uint8Array.of(1, 2, 3));
    expect(await api.readFile('missing.bgtb')).toBeNull();
    await expect(api.saveFile('../escape', Uint8Array.of(1))).rejects.toThrow();
  });
});

describe('production KDF parameters (one test per runtime, TEST_PLAN §2.5)', () => {
  it('unlock takes ≤ 2 s in the browser', async () => {
    const first = startDbWorker();
    workers.push(first.terminate);
    await first.api.configureForTests({ kdfParams: PRODUCTION_KDF_PARAMS });
    await first.api.createVault(PASS);
    await first.api.lock();

    const start = performance.now();
    expect(await first.api.unlock(PASS)).toEqual({ ok: true });
    const ms = performance.now() - start;

    expect(ms).toBeLessThanOrEqual(2000);
  });
});
