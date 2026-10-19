import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PRODUCTION_KDF_PARAMS, settingsSchema, type Repositories } from '@budget/core';
import { createInMemoryRepositories, testKdfParams } from '@budget/core/testing';
import {
  concat,
  DecryptionError,
  deriveKey,
  encrypt,
  FormatError,
  KdfPolicyError,
  randomBytes,
  UnsupportedVersionError,
} from '@budget/crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { backupFileName, createBackup, readBackup, restoreBackup } from './backup';
import { BACKUP_MAGIC, BackupPayloadError, gunzip, gzip, parseBackupHeader } from './format';

const PASS = 'correct horse battery staple 2026';
const fast = { kdfParams: testKdfParams };
const openFast = { minKdf: testKdfParams };
const goldenDir = path.resolve(import.meta.dirname, '../../../test-data/backup');

let repos: Repositories;

async function seed(target: Repositories) {
  await target.categories.seedDefaults();
  const cats = await target.categories.list();
  const food = cats.find((c) => c.name === 'Food')!;
  const salary = cats.find((c) => c.name === 'Salary')!;
  await target.transactions.create({
    kind: 'income',
    amountMinor: 350000,
    currency: 'EUR',
    categoryId: salary.id,
    date: '2026-03-01',
    note: 'Salary',
  });
  const lunch = await target.transactions.create({
    kind: 'expense',
    amountMinor: 1250,
    currency: 'EUR',
    categoryId: food.id,
    date: '2026-03-02',
    note: 'Lunch ā 😀',
  });
  const deleted = await target.transactions.create({
    kind: 'expense',
    amountMinor: 99,
    currency: 'EUR',
    categoryId: food.id,
    date: '2026-03-03',
    note: 'deleted',
  });
  await target.transactions.softDelete(deleted.id);
  await target.settings.set('baseCurrency', 'EUR');
  return { lunch };
}

beforeEach(async () => {
  repos = createInMemoryRepositories();
  await seed(repos);
});

/** Builds a structurally valid backup around arbitrary plaintext bytes (for payload tests). */
async function sealRaw(plaintext: Uint8Array, version = 1): Promise<Uint8Array> {
  const field = (s: string) => {
    const b = new TextEncoder().encode(s);
    return concat(Uint8Array.of(b.length >> 8, b.length & 0xff), b);
  };
  const salt = randomBytes(16);
  const header = concat(
    BACKUP_MAGIC,
    Uint8Array.of(version),
    field('2026-03-15T10:00:00.000Z'),
    field('test'),
    field(JSON.stringify(testKdfParams)),
    salt,
  );
  const key = await deriveKey(PASS, salt, testKdfParams, ['encrypt']);
  return concat(header, await encrypt(key, plaintext, header));
}

describe('createBackup / readBackup', () => {
  it('round-trips the full snapshot, including tombstones', async () => {
    const bytes = await createBackup(repos, PASS, {
      ...fast,
      appVersion: '0.2.0',
      now: () => new Date('2026-03-15T10:00:00Z'),
    });

    const { header, payload } = await readBackup(bytes, PASS, openFast);

    expect(header).toEqual({
      version: 1,
      createdAt: '2026-03-15T10:00:00.000Z',
      appVersion: '0.2.0',
      kdfParams: testKdfParams,
    });
    const snapshot = await repos.snapshots.exportSnapshot();
    expect(payload).toEqual({ schemaVersion: snapshot.settings.schemaVersion, ...snapshot });
    expect(payload.transactions.some((t) => t.deletedAt !== null)).toBe(true);
  });

  it('contains no plaintext and uses a fresh salt per backup', async () => {
    const a = await createBackup(repos, PASS, fast);
    const b = await createBackup(repos, PASS, fast);

    expect(new TextDecoder().decode(a)).not.toContain('Lunch');
    expect(parseBackupHeader(a).salt).not.toEqual(parseBackupHeader(b).salt);
  });

  it('wrong passphrase → DecryptionError', async () => {
    const bytes = await createBackup(repos, PASS, fast);

    await expect(readBackup(bytes, 'not the passphrase', openFast)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it.each([
    ['created_at (header)', 8],
    ['salt (header)', -60],
    ['ciphertext body', -20],
    ['tag', -1],
  ])('tampered %s → error, no data', async (_part, offset) => {
    const bytes = await createBackup(repos, PASS, fast);
    const i = offset < 0 ? bytes.length + offset : offset;
    bytes[i] = (bytes[i] ?? 0) ^ 0x01;

    await expect(readBackup(bytes, PASS, openFast)).rejects.toThrow();
    await expect(readBackup(bytes, PASS, openFast)).rejects.toSatisfy(
      (e) => e instanceof DecryptionError || e instanceof FormatError,
    );
  });

  it('truncated files → FormatError or DecryptionError', async () => {
    const bytes = await createBackup(repos, PASS, fast);

    for (const length of [0, 3, 10, 40, 80, bytes.length - 1]) {
      await expect(readBackup(bytes.subarray(0, length), PASS, openFast)).rejects.toSatisfy(
        (e) => e instanceof DecryptionError || e instanceof FormatError,
      );
    }
  });

  it('wrong magic → FormatError', async () => {
    await expect(
      readBackup(new TextEncoder().encode('BGTV not a backup'), PASS),
    ).rejects.toBeInstanceOf(FormatError);
  });

  it('a backup from a future format version is rejected with a clear message', async () => {
    const bytes = await createBackup(repos, PASS, fast);
    bytes[4] = 2;

    const error = await readBackup(bytes, PASS, openFast).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnsupportedVersionError);
    expect((error as Error).message).toBe(
      'Unsupported format version 2 (this app supports up to 1)',
    );
  });

  it('rejects KDF parameters below the minimum (downgrade guard)', async () => {
    const bytes = await createBackup(repos, PASS, fast);

    await expect(readBackup(bytes, PASS)).rejects.toBeInstanceOf(KdfPolicyError);
    expect(PRODUCTION_KDF_PARAMS.memoryKiB).toBeGreaterThan(testKdfParams.memoryKiB);
  });

  it('a payload that is not gzip, not JSON, or not a valid ledger → BackupPayloadError', async () => {
    const notGzip = await sealRaw(new TextEncoder().encode('plain'));
    const notJson = await sealRaw(await gzip(new TextEncoder().encode('{not json')));
    const wrongShape = await sealRaw(
      await gzip(new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, categories: 'x' }))),
    );

    for (const bytes of [notGzip, notJson, wrongShape]) {
      await expect(readBackup(bytes, PASS, openFast)).rejects.toBeInstanceOf(BackupPayloadError);
    }
  });

  it('gzip bomb: decompression stops at the size limit', async () => {
    const bomb = await gzip(new Uint8Array(5 * 1024 * 1024)); // 5 MB of zeros → a few KB compressed

    expect(bomb.length).toBeLessThan(64 * 1024);
    await expect(gunzip(bomb, 1024 * 1024)).rejects.toThrow('too large');
    const sealed = await sealRaw(bomb);
    await expect(
      readBackup(sealed, PASS, { ...openFast, maxPayloadBytes: 1024 * 1024 }),
    ).rejects.toBeInstanceOf(BackupPayloadError);
  });

  it('names files budget-backup-YYYYMMDD-HHmmss.bgtb', () => {
    expect(backupFileName(new Date(2026, 2, 5, 7, 8, 9))).toBe(
      'budget-backup-20260305-070809.bgtb',
    );
  });
});

describe('restoreBackup', () => {
  it('replace: the target becomes identical to the backup', async () => {
    const { payload } = await readBackup(await createBackup(repos, PASS, fast), PASS, openFast);
    const target = createInMemoryRepositories();
    await target.categories.seedDefaults();
    await target.settings.set('baseCurrency', 'USD');

    expect(await restoreBackup(target, payload, 'replace')).toBeNull();

    expect(await target.snapshots.exportSnapshot()).toEqual(await repos.snapshots.exportSnapshot());
  });

  it('merge: newest updatedAt wins; a newer tombstone wins over an older edit', async () => {
    const backupBytes = await createBackup(repos, PASS, fast);
    const lunch = (await repos.transactions.list({ search: 'Lunch' })).items[0]!;
    // Local edit after the backup → local is newer and must survive.
    await repos.transactions.update(lunch.id, { note: 'Lunch edited later' });
    const { payload } = await readBackup(backupBytes, PASS, openFast);
    const salary = payload.transactions.find((t) => t.note === 'Salary')!;
    const later = new Date(Date.now() + 60_000).toISOString();
    const incoming = {
      ...payload,
      transactions: payload.transactions.map((t) =>
        t.id === salary.id ? { ...t, deletedAt: later, updatedAt: later } : t,
      ),
    };

    const result = await restoreBackup(repos, incoming, 'merge');

    expect(result?.transactions.updated).toBe(1);
    expect((await repos.transactions.get(lunch.id))?.note).toBe('Lunch edited later');
    expect(await repos.transactions.get(salary.id)).toBeNull();
  });
});

describe('golden backup files (backward compatibility)', () => {
  // To add a golden file for a new format/schema version: UPDATE_GOLDEN=1 pnpm vitest run --project backup
  it.runIf(process.env.UPDATE_GOLDEN === '1')(
    'writes the golden file for the current format',
    async () => {
      const dir = path.join(goldenDir, 'v1');
      mkdirSync(dir, { recursive: true });
      const bytes = await createBackup(repos, PASS, {
        appVersion: '0.2.0',
        now: () => new Date('2026-03-15T10:00:00Z'),
      });
      writeFileSync(path.join(dir, 'golden.bgtb'), bytes);
      const { payload } = await readBackup(bytes, PASS);
      writeFileSync(
        path.join(dir, 'golden.expected.json'),
        `${JSON.stringify(payload, null, 2)}\n`,
      );
    },
  );

  const files = existsSync(goldenDir)
    ? readdirSync(goldenDir)
        .filter((v) => /^v\d+$/.test(v))
        .flatMap((v) =>
          readdirSync(path.join(goldenDir, v))
            .filter((f) => f.endsWith('.bgtb'))
            .map((f) => path.join(v, f)),
        )
    : [];

  it('at least one golden file exists', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s restores and matches its expected JSON', async (file) => {
    const bytes = new Uint8Array(readFileSync(path.join(goldenDir, file)));
    const expected: unknown = JSON.parse(
      readFileSync(path.join(goldenDir, file.replace(/\.bgtb$/, '.expected.json')), 'utf8'),
    );

    const { payload } = await readBackup(bytes, PASS);
    const target = createInMemoryRepositories();
    await restoreBackup(target, payload, 'replace');

    // Golden JSON is frozen at its release; settings added later appear with their defaults.
    const golden = expected as typeof payload;
    expect(payload).toEqual({ ...golden, settings: settingsSchema.parse(golden.settings) });
    expect((await target.transactions.list({})).total).toBe(2);
  });
});
