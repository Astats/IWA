import { HttpResponse } from 'msw/http';
import { beforeEach, describe, expect, it } from 'vitest';

import { DropboxProvider, MAX_BACKUP_FILE_BYTES } from '../src';
import { bytesOf, expectProviderError, runProviderContract } from './contract/provider.contract';
import { CONTENT, FakeDropbox } from './mocks/dropbox';
import { FakeSession } from './mocks/fake-session';
import { server } from './msw';

const name = (day: number) => `budget-backup-202603${String(day).padStart(2, '0')}-120000.bgtb`;

function setup({ connected = true } = {}) {
  const dropbox = new FakeDropbox();
  server.use(...dropbox.handlers());
  const session = new FakeSession();
  session.signedIn = connected;
  const delays: number[] = [];
  const provider = new DropboxProvider(session, {
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  });
  return { dropbox, session, provider, delays };
}

runProviderContract(
  'DropboxProvider (MSW Dropbox API)',
  () => setup({ connected: false }).provider,
);

describe('DropboxProvider', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  const isList = (r: Request) => r.url.includes('/2/files/list_folder');

  it('lists the app folder across pages, ignoring folders and foreign files', async () => {
    ctx.dropbox.pageSize = 2;
    ctx.dropbox.seed(name(1));
    ctx.dropbox.seed('readme.txt');
    ctx.dropbox.seed(name(2), new Uint8Array(1), { folder: true });
    ctx.dropbox.seed(name(3));
    ctx.dropbox.seed(name(4));

    expect((await ctx.provider.list()).map((b) => b.name)).toEqual([name(4), name(3), name(1)]);
    expect(
      ctx.dropbox.requests.filter((r) => isList(new Request(r.url, { method: 'POST' }))),
    ).toHaveLength(3);
  });

  it('uploads with mode=add and strict_conflict; a name clash is CONFLICT', async () => {
    const uploaded = await ctx.provider.upload(name(5), bytesOf(321));
    expect(uploaded).toMatchObject({ name: name(5), size: 321 });
    const arg = JSON.parse(ctx.dropbox.requests.at(-1)!.apiArg!) as Record<string, unknown>;
    expect(arg).toEqual({
      path: `/${name(5)}`,
      mode: 'add',
      autorename: false,
      mute: true,
      strict_conflict: true,
    });

    await expectProviderError(ctx.provider.upload(name(5), bytesOf(1)), 'CONFLICT');
  });

  it('does not retry an upload after a 5xx (it is not idempotent)', async () => {
    ctx.dropbox.fail(
      (r) => r.url === `${CONTENT}/2/files/upload`,
      () => new HttpResponse(null, { status: 503 }),
    );
    await expectProviderError(ctx.provider.upload(name(6), bytesOf(5)), 'UNAVAILABLE');
    expect(ctx.dropbox.requests.filter((r) => r.url.endsWith('/upload'))).toHaveLength(1);
    expect(await ctx.provider.list()).toEqual([]);
  });

  it('a network drop during upload leaves no file', async () => {
    ctx.dropbox.fail(
      (r) => r.url.endsWith('/upload'),
      () => HttpResponse.error(),
    );
    await expectProviderError(ctx.provider.upload(name(7), bytesOf(5)), 'NETWORK');
    expect(await ctx.provider.list()).toEqual([]);
  });

  it('retries rate limiting (429 + Retry-After) and 5xx on reads', async () => {
    ctx.dropbox.fail(
      isList,
      () => new HttpResponse(null, { status: 429, headers: { 'Retry-After': '1' } }),
    );
    ctx.dropbox.fail(isList, () => new HttpResponse(null, { status: 500 }));
    expect(await ctx.provider.list()).toEqual([]);
    expect(ctx.delays).toEqual([1000, 1000]);
  });

  it('401 (expired token) forgets the session', async () => {
    ctx.dropbox.token = 'other';
    await expectProviderError(ctx.provider.list(), 'AUTH_REQUIRED');
    expect(ctx.provider.isConnected()).toBe(false);
  });

  it('maps unknown 409 summaries to UNAVAILABLE and malformed bodies to INVALID_RESPONSE', async () => {
    ctx.dropbox.fail(isList, () =>
      HttpResponse.json({ error_summary: 'something_new/' }, { status: 409 }),
    );
    await expectProviderError(ctx.provider.list(), 'UNAVAILABLE');
    ctx.dropbox.fail(isList, () => HttpResponse.json({ entries: 'nope' }));
    await expectProviderError(ctx.provider.list(), 'INVALID_RESPONSE');
  });

  it('checks download metadata before reading the body', async () => {
    const other = ctx.dropbox.seed('readme.txt');
    await expectProviderError(ctx.provider.download(other.id), 'NOT_FOUND');

    const huge = ctx.dropbox.seed(name(8));
    Object.defineProperty(huge, 'bytes', { value: new Uint8Array(0) });
    ctx.dropbox.fail(
      (r) => r.url.endsWith('/download'),
      () =>
        new HttpResponse(new Uint8Array(1), {
          headers: {
            'Dropbox-API-Result': JSON.stringify({
              '.tag': 'file',
              id: huge.id,
              name: huge.name,
              size: MAX_BACKUP_FILE_BYTES + 1,
              server_modified: '2026-03-01T00:00:00Z',
            }),
          },
        }),
    );
    await expectProviderError(ctx.provider.download(huge.id), 'INVALID_RESPONSE');

    ctx.dropbox.fail(
      (r) => r.url.endsWith('/download'),
      () => new HttpResponse(new Uint8Array(1)),
    );
    await expectProviderError(ctx.provider.download(huge.id), 'INVALID_RESPONSE');
  });

  it('escapes non-ASCII characters in Dropbox-API-Arg', async () => {
    await expectProviderError(ctx.provider.download('id:ünïcode'), 'NOT_FOUND');
    expect(ctx.dropbox.requests.at(-1)?.apiArg).toBe('{"path":"id:\\u00fcn\\u00efcode"}');
  });

  it('never puts the access token into a URL', async () => {
    ctx.dropbox.seed(name(9));
    const [item] = await ctx.provider.list();
    await ctx.provider.download(item!.id);
    await ctx.provider.delete(item!.id);
    expect(ctx.dropbox.requests.every((r) => !r.url.includes('test-access-token'))).toBe(true);
  });
});
