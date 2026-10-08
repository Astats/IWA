import { HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it } from 'vitest';

import { GDRIVE_CHUNK_BYTES, GoogleDriveProvider, MAX_BACKUP_FILE_BYTES } from '../src';
import { bytesOf, expectProviderError, runProviderContract } from './contract/provider.contract';
import { FakeSession } from './mocks/fake-session';
import { FakeDrive } from './mocks/gdrive';
import { server } from './msw';

const name = (day: number) => `budget-backup-202603${String(day).padStart(2, '0')}-120000.bgtb`;

function setup({ connected = true } = {}) {
  const drive = new FakeDrive();
  server.use(...drive.handlers());
  const session = new FakeSession();
  session.signedIn = connected;
  const delays: number[] = [];
  const provider = new GoogleDriveProvider(session, {
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  });
  return { drive, session, provider, delays };
}

runProviderContract(
  'GoogleDriveProvider (MSW Drive v3)',
  () => setup({ connected: false }).provider,
);

describe('GoogleDriveProvider', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  const isList = (r: Request) =>
    r.method === 'GET' && new URL(r.url).pathname === '/drive/v3/files';

  it('lists the appDataFolder across pages and ignores foreign files', async () => {
    ctx.drive.pageSize = 2;
    ctx.drive.seed(name(1));
    ctx.drive.seed('notes.txt');
    ctx.drive.seed(name(3));
    ctx.drive.seed(name(4), new Uint8Array(1), ['root']); // not in the app folder
    ctx.drive.seed(name(5));

    expect((await ctx.provider.list()).map((b) => b.name)).toEqual([name(5), name(3), name(1)]);
    const lists = ctx.drive.requests.filter((r) => isList(new Request(r.url)));
    expect(lists).toHaveLength(2);
    expect(lists.every((r) => new URL(r.url).searchParams.get('spaces') === 'appDataFolder')).toBe(
      true,
    );
  });

  it('uploads small files as one multipart request into appDataFolder', async () => {
    const uploaded = await ctx.provider.upload(name(6), bytesOf(1234));

    expect(uploaded).toMatchObject({ name: name(6), size: 1234 });
    expect([...ctx.drive.files.values()][0]?.parents).toEqual(['appDataFolder']);
    const posts = ctx.drive.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain('uploadType=multipart');
  });

  it('uses a resumable session with 256 KiB-multiple chunks for files over 5 MB', async () => {
    const big = bytesOf(5 * 1024 * 1024 + 7, 2);

    const uploaded = await ctx.provider.upload(name(7), big);

    const chunks = ctx.drive.requests.filter((r) => r.method === 'PUT').map((r) => r.contentRange);
    expect(chunks).toEqual([
      `bytes 0-${GDRIVE_CHUNK_BYTES - 1}/${big.length}`,
      `bytes ${GDRIVE_CHUNK_BYTES}-${big.length - 1}/${big.length}`,
    ]);
    expect(GDRIVE_CHUNK_BYTES % (256 * 1024)).toBe(0);
    expect(Buffer.compare(await ctx.provider.download(uploaded.id), big)).toBe(0);
  });

  it('after a lost chunk response, asks the session where to continue', async () => {
    const big = bytesOf(3 * GDRIVE_CHUNK_BYTES, 3);
    ctx.drive.loseChunkResponses = 1;

    const uploaded = await ctx.provider.upload(name(8), big);

    const puts = ctx.drive.requests.filter((r) => r.method === 'PUT').map((r) => r.contentRange);
    expect(puts).toContain(`bytes */${big.length}`);
    expect(Buffer.compare(await ctx.provider.download(uploaded.id), big)).toBe(0);
  });

  it('a network drop mid-upload cancels the session and leaves no file', async () => {
    const big = bytesOf(2 * GDRIVE_CHUNK_BYTES + 5, 4);
    ctx.drive.fail(
      (r) =>
        r.method === 'PUT' &&
        r.headers.get('content-range')?.startsWith(`bytes ${GDRIVE_CHUNK_BYTES}-`) === true,
      () => HttpResponse.error(),
      10,
    );

    await expectProviderError(ctx.provider.upload(name(9), big), 'NETWORK');

    expect(
      ctx.drive.requests.some((r) => r.method === 'DELETE' && r.url.includes('upload_id')),
    ).toBe(true);
    expect(ctx.drive.sessions.size).toBe(0);
    expect(await ctx.provider.list()).toEqual([]);
  });

  it('rejects an upload session URI on another origin (the token would go there)', async () => {
    ctx.drive.fail(
      (r) => r.method === 'POST' && r.url.includes('uploadType=resumable'),
      () =>
        new HttpResponse(null, {
          status: 200,
          headers: { Location: 'https://evil.example/upload' },
        }),
    );
    await expectProviderError(
      ctx.provider.upload(name(10), bytesOf(6 * 1024 * 1024)),
      'INVALID_RESPONSE',
    );
  });

  it('does not retry a multipart upload after a 5xx (it could duplicate the file)', async () => {
    ctx.drive.fail(
      (r) => r.method === 'POST',
      () => new HttpResponse(null, { status: 503 }),
    );

    await expectProviderError(ctx.provider.upload(name(11), bytesOf(10)), 'UNAVAILABLE');
    expect(ctx.drive.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('treats a 403 rateLimitExceeded like 429 and retries', async () => {
    ctx.drive.fail(isList, () =>
      HttpResponse.json(
        { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } },
        { status: 403 },
      ),
    );

    expect(await ctx.provider.list()).toEqual([]);
    expect(ctx.delays).toEqual([500]);
  });

  it('a plain 403 is FORBIDDEN and is not retried', async () => {
    ctx.drive.fail(isList, () =>
      HttpResponse.json(
        { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } },
        { status: 403 },
      ),
    );
    await expectProviderError(ctx.provider.list(), 'FORBIDDEN');
    expect(ctx.delays).toEqual([]);
  });

  it('401 forgets the session', async () => {
    ctx.drive.token = 'expired';
    await expectProviderError(ctx.provider.list(), 'AUTH_REQUIRED');
    expect(ctx.provider.isConnected()).toBe(false);
  });

  it('rejects malformed listings', async () => {
    ctx.drive.fail(isList, () => HttpResponse.json({ items: [] }));
    await expectProviderError(ctx.provider.list(), 'INVALID_RESPONSE');
  });

  it('refuses to download files that are not backups or are too large', async () => {
    const other = ctx.drive.seed('other.txt');
    await expectProviderError(ctx.provider.download(other.id), 'NOT_FOUND');
    const huge = ctx.drive.seed(name(12));
    Object.defineProperty(huge, 'bytes', { value: { length: MAX_BACKUP_FILE_BYTES + 1 } });
    await expectProviderError(ctx.provider.download(huge.id), 'INVALID_RESPONSE');
  });

  it('never puts the access token into a URL', async () => {
    ctx.drive.seed(name(13));
    const [item] = await ctx.provider.list();
    await ctx.provider.download(item!.id);
    await ctx.provider.delete(item!.id);
    expect(ctx.drive.requests.every((r) => !r.url.includes('test-access-token'))).toBe(true);
  });
});
