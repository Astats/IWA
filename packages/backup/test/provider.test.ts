import { describe, expect, it } from 'vitest';

import {
  applyRetention,
  compareNewestFirst,
  createProviderRegistry,
  normalizeListing,
  uploadBackup,
  type RemoteBackup,
} from '../src';
import { FakeBackupProvider } from '../src/testing';
import { bytesOf, expectProviderError, runProviderContract } from './contract/provider.contract';

runProviderContract('FakeBackupProvider', () => new FakeBackupProvider());

const name = (day: number) => `budget-backup-202601${String(day).padStart(2, '0')}-120000.bgtb`;

function seeded(days: number[]) {
  const provider = new FakeBackupProvider({ connected: true });
  for (const day of days) provider.seed(name(day), bytesOf(8, day));
  return provider;
}

describe('normalizeListing', () => {
  it('drops foreign or malformed entries and sorts newest first', () => {
    const items: unknown[] = [
      { id: 'a', name: name(1), size: 1, createdAt: '2026-01-01T12:00:00Z' },
      { id: 'b', name: 'notes.txt', size: 1, createdAt: '2026-01-02T12:00:00Z' },
      { id: 'c', name: name(3), size: -1, createdAt: '2026-01-03T12:00:00Z' },
      { id: '', name: name(4), size: 1, createdAt: '2026-01-04T12:00:00Z' },
      { id: 'e', name: name(5), size: 1, createdAt: 'yesterday' },
      { id: 'f', name: name(6), size: 1, createdAt: '2026-01-06T12:00:00+02:00', extra: true },
      null,
      'budget-backup-20260107-120000.bgtb',
    ];
    expect(normalizeListing(items)).toEqual([
      { id: 'f', name: name(6), size: 1, createdAt: '2026-01-06T12:00:00+02:00' },
      { id: 'a', name: name(1), size: 1, createdAt: '2026-01-01T12:00:00Z' },
    ]);
  });

  it('breaks name ties by the provider timestamp', () => {
    const a: RemoteBackup = { id: 'a', name: name(1), size: 1, createdAt: '2026-01-01T12:00:00Z' };
    const b: RemoteBackup = { ...a, id: 'b', createdAt: '2026-01-01T12:00:05Z' };
    expect([a, b].sort(compareNewestFirst).map((x) => x.id)).toEqual(['b', 'a']);
    expect(compareNewestFirst(a, a)).toBe(0);
  });
});

describe('applyRetention', () => {
  it('keeps the newest N and deletes the rest', async () => {
    const provider = seeded([1, 2, 3, 4, 5]);
    const result = await applyRetention(provider, 3);
    expect(result.kept.map((b) => b.name)).toEqual([name(5), name(4), name(3)]);
    expect(result.deleted.map((b) => b.name)).toEqual([name(2), name(1)]);
    expect(result.failed).toEqual([]);
    expect((await provider.list()).map((b) => b.name)).toEqual([name(5), name(4), name(3)]);
  });

  it('does nothing when there are at most N backups', async () => {
    const provider = seeded([1, 2]);
    expect((await applyRetention(provider, 10)).deleted).toEqual([]);
    expect(await provider.list()).toHaveLength(2);
  });

  it('never deletes the protected (just uploaded) backup, even if it sorts as old', async () => {
    const provider = seeded([5, 6, 7]);
    const justUploaded = provider.seed(name(1), bytesOf(8)); // device clock was wrong
    const result = await applyRetention(provider, 2, justUploaded.id);
    expect(result.kept.map((b) => b.name)).toEqual([name(7), name(1)]);
    expect((await provider.list()).map((b) => b.name)).toEqual([name(7), name(1)]);
  });

  it('collects deletion failures without throwing', async () => {
    const provider = seeded([1, 2, 3]).failNext('delete', 'UNAVAILABLE');
    const result = await applyRetention(provider, 1);
    expect(result.failed.map((b) => b.name)).toEqual([name(2)]);
    expect(result.deleted.map((b) => b.name)).toEqual([name(1)]);
  });

  it('rejects a non-positive or fractional N', async () => {
    const provider = seeded([1]);
    await expect(applyRetention(provider, 0)).rejects.toThrow(RangeError);
    await expect(applyRetention(provider, 1.5)).rejects.toThrow(RangeError);
  });
});

describe('uploadBackup', () => {
  it('uploads and applies retention', async () => {
    const provider = seeded([1, 2, 3]);
    const { uploaded, retention } = await uploadBackup(provider, name(4), bytesOf(9), 2);
    expect(uploaded).toMatchObject({ name: name(4), size: 9 });
    expect(retention?.deleted.map((b) => b.name)).toEqual([name(2), name(1)]);
  });

  it('still succeeds when retention cannot list', async () => {
    const provider = seeded([1]).failNext('list', 'UNAVAILABLE');
    const { uploaded, retention } = await uploadBackup(provider, name(2), bytesOf(9), 1);
    expect(uploaded.name).toBe(name(2));
    expect(retention).toBeNull();
  });

  it('a failed upload stores nothing and deletes nothing', async () => {
    const provider = seeded([1, 2]).failNext('upload', 'NETWORK');
    await expectProviderError(uploadBackup(provider, name(3), bytesOf(9), 1), 'NETWORK');
    expect((await provider.list()).map((b) => b.name)).toEqual([name(2), name(1)]);
  });

  it('rejects names that are not backup file names', async () => {
    const provider = seeded([]);
    await expect(uploadBackup(provider, '../evil.bgtb', bytesOf(1), 1)).rejects.toThrow(RangeError);
    expect(provider.files.size).toBe(0);
  });
});

describe('provider registry', () => {
  it('lists providers in order and finds them by id', () => {
    const a = new FakeBackupProvider({ id: 'onedrive' });
    const b = new FakeBackupProvider({ id: 'dropbox' });
    const registry = createProviderRegistry([a, b]);
    expect(registry.all()).toEqual([a, b]);
    expect(registry.get('dropbox')).toBe(b);
    expect(registry.get('gdrive')).toBeUndefined();
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      createProviderRegistry([new FakeBackupProvider(), new FakeBackupProvider()]),
    ).toThrow(/Duplicate/);
  });

  it('disconnectAll forgets every session, even if one fails', async () => {
    const a = new FakeBackupProvider({ id: 'onedrive', connected: true });
    const b = new FakeBackupProvider({ id: 'dropbox', connected: true });
    b.disconnect = () => Promise.reject(new Error('boom'));
    await createProviderRegistry([a, b]).disconnectAll();
    expect(a.isConnected()).toBe(false);
  });
});

describe('FakeBackupProvider', () => {
  it('an AUTH_REQUIRED failure drops the session, like a revoked token', async () => {
    const provider = seeded([1]).failNext('list', 'AUTH_REQUIRED');
    await expectProviderError(provider.list(), 'AUTH_REQUIRED');
    expect(provider.isConnected()).toBe(false);
  });

  it('connect can be cancelled', async () => {
    const provider = new FakeBackupProvider().failNext('connect', 'CANCELLED');
    await expectProviderError(provider.connect(), 'CANCELLED');
    expect(provider.isConnected()).toBe(false);
  });

  it('revoke() ends the session', async () => {
    const provider = seeded([1]);
    provider.revoke();
    await expectProviderError(provider.list(), 'AUTH_REQUIRED');
  });

  it('supports artificial latency', async () => {
    const provider = new FakeBackupProvider({ connected: true, latencyMs: 5 });
    const started = Date.now();
    await provider.list();
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
  });
});
