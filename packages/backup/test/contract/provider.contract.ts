import { describe, expect, it } from 'vitest';

import { ProviderError, type BackupProvider, type ProviderErrorCode } from '../../src';

/** Factory for a fresh provider over an empty app folder (not yet connected). */
export type MakeProvider = () => Promise<BackupProvider> | BackupProvider;

export async function expectProviderError(
  promise: Promise<unknown>,
  code: ProviderErrorCode,
): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected ProviderError ${code}`).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).code).toBe(code);
}

export function bytesOf(size: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) & 0xff;
  return bytes;
}

/**
 * BackupProvider contract (TEST_PLAN 3.1). The fake and every real adapter (over MSW mocks) must
 * pass it unchanged.
 */
export function runProviderContract(name: string, make: MakeProvider): void {
  describe(`backup provider contract: ${name}`, () => {
    const connected = async () => {
      const provider = await make();
      await provider.connect();
      return provider;
    };

    it('requires a connection for every file operation', async () => {
      const provider = await make();
      expect(provider.isConnected()).toBe(false);
      await expectProviderError(provider.list(), 'AUTH_REQUIRED');
      await expectProviderError(
        provider.upload('budget-backup-20260101-000000.bgtb', bytesOf(10)),
        'AUTH_REQUIRED',
      );
      await expectProviderError(provider.download('x'), 'AUTH_REQUIRED');
      await expectProviderError(provider.delete('x'), 'AUTH_REQUIRED');
    });

    it('connects, and an empty app folder lists nothing', async () => {
      const provider = await connected();
      expect(provider.isConnected()).toBe(true);
      expect(await provider.list()).toEqual([]);
    });

    it('uploads, lists newest first, downloads identical bytes and deletes', async () => {
      const provider = await connected();
      const older = await provider.upload('budget-backup-20260101-080000.bgtb', bytesOf(100, 1));
      const newer = await provider.upload('budget-backup-20260102-080000.bgtb', bytesOf(200, 2));
      expect(older).toMatchObject({ name: 'budget-backup-20260101-080000.bgtb', size: 100 });
      expect(newer.id).not.toBe(older.id);

      const listed = await provider.list();
      expect(listed.map((b) => b.name)).toEqual([newer.name, older.name]);
      expect(listed[0]).toMatchObject({ id: newer.id, size: 200 });
      expect(Number.isNaN(Date.parse(listed[0]!.createdAt))).toBe(false);

      expect(await provider.download(older.id)).toEqual(bytesOf(100, 1));
      await provider.delete(older.id);
      expect((await provider.list()).map((b) => b.id)).toEqual([newer.id]);
    });

    it('round-trips a file larger than 4 MB', async () => {
      const provider = await connected();
      const big = bytesOf(5 * 1024 * 1024 + 123, 7);
      const uploaded = await provider.upload('budget-backup-20260103-080000.bgtb', big);
      expect(uploaded.size).toBe(big.length);
      // Deep toEqual on 5 MB is very slow; compare bytes directly.
      expect(Buffer.compare(await provider.download(uploaded.id), big)).toBe(0);
    });

    it('reports unknown ids as NOT_FOUND', async () => {
      const provider = await connected();
      await expectProviderError(provider.download('does-not-exist'), 'NOT_FOUND');
      await expectProviderError(provider.delete('does-not-exist'), 'NOT_FOUND');
    });

    it('disconnect forgets the session', async () => {
      const provider = await connected();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
      await expectProviderError(provider.list(), 'AUTH_REQUIRED');
    });
  });
}
