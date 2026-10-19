import { http, HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_BACKUP_FILE_BYTES, OneDriveProvider, UPLOAD_CHUNK_BYTES } from '../src';
import { bytesOf, expectProviderError, runProviderContract } from './contract/provider.contract';
import { FakeSession } from './mocks/fake-session';
import { DOWNLOAD_HOST, FakeGraph, GRAPH, UPLOAD_HOST } from './mocks/graph';
import { server } from './msw';

const name = (day: number) => `budget-backup-202603${String(day).padStart(2, '0')}-120000.bgtb`;

function setup({ connected = true } = {}) {
  const graph = new FakeGraph();
  server.use(...graph.handlers());
  const session = new FakeSession();
  session.signedIn = connected;
  const delays: number[] = [];
  const provider = new OneDriveProvider(session, {
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  });
  return { graph, session, provider, delays };
}

runProviderContract('OneDriveProvider (MSW Graph)', () => setup({ connected: false }).provider);

describe('OneDriveProvider', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  const isList = (r: Request) => r.method === 'GET' && r.url.includes('/approot/children');

  it('lists across pages and ignores folders and foreign files', async () => {
    ctx.graph.pageSize = 2;
    ctx.graph.seed(name(1));
    ctx.graph.seed('notes.txt');
    ctx.graph.seed(name(2), new Uint8Array(8), { folder: true });
    ctx.graph.seed(name(3));
    ctx.graph.seed(name(4));

    const listed = await ctx.provider.list();

    expect(listed.map((b) => b.name)).toEqual([name(4), name(3), name(1)]);
    expect(ctx.graph.requests.filter((r) => r.url.includes('/children'))).toHaveLength(3);
  });

  it('never follows a nextLink to another origin (token stays with Graph)', async () => {
    // Takes precedence over the fake Graph's handler.
    server.use(
      http.get(`${GRAPH}/me/drive/special/approot/children`, () =>
        HttpResponse.json({ value: [], '@odata.nextLink': 'https://evil.example/steal' }),
      ),
    );

    await expectProviderError(ctx.provider.list(), 'INVALID_RESPONSE');
  });

  it('uses a simple PUT with conflictBehavior=fail up to 4 MB', async () => {
    const uploaded = await ctx.provider.upload(name(5), bytesOf(1000));

    expect(uploaded).toMatchObject({ name: name(5), size: 1000 });
    const put = ctx.graph.requests.find((r) => r.method === 'PUT')!;
    expect(put.url).toContain('/approot:/budget-backup-20260305-120000.bgtb:/content');
    expect(put.authorization).toBe('Bearer test-access-token');
  });

  it('uses an upload session with 320 KiB-multiple fragments and no token for larger files', async () => {
    const big = bytesOf(4 * 1024 * 1024 + 1, 3);

    const uploaded = await ctx.provider.upload(name(6), big);

    expect(uploaded.size).toBe(big.length);
    const fragments = ctx.graph.requests.filter((r) => r.url.startsWith(UPLOAD_HOST));
    expect(fragments.map((r) => r.contentRange)).toEqual([
      `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${big.length}`,
      `bytes ${UPLOAD_CHUNK_BYTES}-${big.length - 1}/${big.length}`,
    ]);
    expect(fragments.every((r) => r.authorization === null)).toBe(true);
    expect(UPLOAD_CHUNK_BYTES % (320 * 1024)).toBe(0);
    expect(Buffer.compare(await ctx.provider.download(uploaded.id), big)).toBe(0);
  });

  it('retries a failed fragment with backoff', async () => {
    const big = bytesOf(3 * UPLOAD_CHUNK_BYTES, 4);
    const isFragment = (r: Request) => r.method === 'PUT' && r.url.startsWith(UPLOAD_HOST);
    ctx.graph.fail(isFragment, () => new HttpResponse(null, { status: 503 }));
    ctx.graph.fail(isFragment, () => HttpResponse.error());

    const uploaded = await ctx.provider.upload(name(7), big);

    expect(Buffer.compare(await ctx.provider.download(uploaded.id), big)).toBe(0);
    expect(ctx.delays).toEqual([500, 1000]);
  });

  it('resumes from the server state after 416 (fragment stored, response lost)', async () => {
    const big = bytesOf(3 * UPLOAD_CHUNK_BYTES, 6);
    ctx.graph.loseFragmentResponses = 1;

    const uploaded = await ctx.provider.upload(name(14), big);

    const fragmentStatuses = ctx.graph.requests
      .filter((r) => r.url.startsWith(UPLOAD_HOST))
      .map((r) => `${r.method} ${r.contentRange ?? ''}`.trim());
    expect(fragmentStatuses).toEqual([
      `PUT bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${big.length}`,
      `PUT bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${big.length}`, // retried → 416
      'GET', // upload status: continue at UPLOAD_CHUNK_BYTES
      `PUT bytes ${UPLOAD_CHUNK_BYTES}-${2 * UPLOAD_CHUNK_BYTES - 1}/${big.length}`,
      `PUT bytes ${2 * UPLOAD_CHUNK_BYTES}-${big.length - 1}/${big.length}`,
    ]);
    expect(Buffer.compare(await ctx.provider.download(uploaded.id), big)).toBe(0);
  });

  it('a network drop mid-upload cancels the session and leaves no file', async () => {
    const big = bytesOf(2 * UPLOAD_CHUNK_BYTES + 10, 5);
    ctx.graph.fail(
      (r) =>
        r.method === 'PUT' &&
        r.url.startsWith(UPLOAD_HOST) &&
        r.headers.get('content-range')?.startsWith(`bytes ${UPLOAD_CHUNK_BYTES}-`) === true,
      () => HttpResponse.error(),
      10,
    );

    await expectProviderError(ctx.provider.upload(name(8), big), 'NETWORK');

    expect(
      ctx.graph.requests.some((r) => r.method === 'DELETE' && r.url.startsWith(UPLOAD_HOST)),
    ).toBe(true);
    expect(ctx.graph.sessions.size).toBe(0);
    expect(await ctx.provider.list()).toEqual([]);
  });

  it('a name conflict is a typed CONFLICT error', async () => {
    ctx.graph.seed(name(9));
    await expectProviderError(ctx.provider.upload(name(9), bytesOf(10)), 'CONFLICT');
  });

  it('does not retry a non-idempotent upload after a 5xx', async () => {
    ctx.graph.fail(
      (r) => r.method === 'PUT',
      () => new HttpResponse(null, { status: 500 }),
    );

    await expectProviderError(ctx.provider.upload(name(10), bytesOf(10)), 'UNAVAILABLE');
    expect(ctx.graph.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
  });

  it('retries 429 honoring Retry-After, and 5xx on reads with backoff', async () => {
    ctx.graph.fail(
      isList,
      () => new HttpResponse(null, { status: 429, headers: { 'Retry-After': '2' } }),
    );
    ctx.graph.fail(isList, () => new HttpResponse(null, { status: 502 }));

    expect(await ctx.provider.list()).toEqual([]);
    expect(ctx.delays).toEqual([2000, 1000]);
  });

  it('gives up after the retry budget with a typed error', async () => {
    ctx.graph.fail(isList, () => new HttpResponse(null, { status: 503 }), 4);
    await expectProviderError(ctx.provider.list(), 'UNAVAILABLE');
    ctx.graph.fail(isList, () => new HttpResponse(null, { status: 429 }), 4);
    await expectProviderError(ctx.provider.list(), 'RATE_LIMITED');
  });

  it('401 forgets the session so the user is asked to connect again', async () => {
    ctx.graph.token = 'revoked';

    await expectProviderError(ctx.provider.list(), 'AUTH_REQUIRED');
    expect(ctx.provider.isConnected()).toBe(false);
  });

  it('403 is a typed FORBIDDEN error', async () => {
    ctx.graph.fail(isList, () => new HttpResponse(null, { status: 403 }));
    await expectProviderError(ctx.provider.list(), 'FORBIDDEN');
    expect(ctx.provider.isConnected()).toBe(true);
  });

  it.each([
    ['not JSON', () => new HttpResponse('<html>', { status: 200 })],
    ['the wrong shape', () => HttpResponse.json({ items: [] })],
  ])('rejects a listing that is %s', async (_label, response) => {
    ctx.graph.fail(isList, response);
    await expectProviderError(ctx.provider.list(), 'INVALID_RESPONSE');
  });

  it('downloads without sending the token to the download host', async () => {
    const item = ctx.graph.seed(name(11), bytesOf(64));

    expect(await ctx.provider.download(item.id)).toEqual(bytesOf(64));
    const dl = ctx.graph.requests.find((r) => r.url.startsWith(DOWNLOAD_HOST))!;
    expect(dl.authorization).toBeNull();
  });

  it('refuses to download files that are not backups or are too large', async () => {
    const other = ctx.graph.seed('passwords.txt');
    await expectProviderError(ctx.provider.download(other.id), 'NOT_FOUND');

    const huge = ctx.graph.seed(name(12));
    Object.defineProperty(huge, 'bytes', { value: { length: MAX_BACKUP_FILE_BYTES + 1 } });
    await expectProviderError(ctx.provider.download(huge.id), 'INVALID_RESPONSE');
  });

  it('never puts the access token into a URL', async () => {
    ctx.graph.seed(name(13));
    const [item] = await ctx.provider.list();
    await ctx.provider.download(item!.id);
    await ctx.provider.delete(item!.id);
    expect(ctx.graph.requests.every((r) => !r.url.includes('test-access-token'))).toBe(true);
  });
});
