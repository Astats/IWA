import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';

import {
  DropboxProvider,
  GDRIVE_CHUNK_BYTES,
  GoogleDriveProvider,
  OneDriveProvider,
  UPLOAD_CHUNK_BYTES,
  type BackupProvider,
  type OAuthSession,
} from '../src';
import { bytesOf, expectProviderError } from './contract/provider.contract';
import { FakeDropbox } from './mocks/dropbox';
import { FakeSession } from './mocks/fake-session';
import { FakeDrive } from './mocks/gdrive';
import { FakeGraph, UPLOAD_HOST } from './mocks/graph';
import { server } from './msw';

const fast = { sleep: () => Promise.resolve() };
const signedIn = () => {
  const session = new FakeSession();
  session.signedIn = true;
  return session;
};
const name = 'budget-backup-20260301-120000.bgtb';

const adapters: Array<[string, (s: OAuthSession) => BackupProvider, () => void]> = [
  [
    'OneDrive',
    (s) => new OneDriveProvider(s, fast),
    () => server.use(...new FakeGraph().handlers()),
  ],
  [
    'Google Drive',
    (s) => new GoogleDriveProvider(s, fast),
    () => server.use(...new FakeDrive().handlers()),
  ],
  [
    'Dropbox',
    (s) => new DropboxProvider(s, fast),
    () => server.use(...new FakeDropbox().handlers()),
  ],
];

describe.each(adapters)('%s adapter edge cases', (_name, make, mock) => {
  it('refuses to upload under a name that is not a backup file name', () => {
    mock();
    expect(() => make(signedIn()).upload('../escape.bgtb', bytesOf(1))).toThrow(RangeError);
  });

  it('forwards connect/disconnect to the session', async () => {
    mock();
    const session = new FakeSession();
    const provider = make(session);
    await provider.connect();
    expect(session.signIns).toBe(1);
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
  });
});

describe('Google Drive edge cases', () => {
  it('prepare() is forwarded to the session (or resolves without one)', async () => {
    const calls: string[] = [];
    const session = Object.assign(signedIn(), {
      prepare: () => {
        calls.push('prepare');
        return Promise.resolve();
      },
    });
    await new GoogleDriveProvider(session, fast).prepare();
    await new GoogleDriveProvider(signedIn(), fast).prepare();
    expect(calls).toEqual(['prepare']);
  });

  it('rejects an upload response that is not a backup file resource', async () => {
    const drive = new FakeDrive();
    server.use(...drive.handlers());
    drive.fail(
      (r) => r.method === 'POST',
      () => HttpResponse.json({ id: 'x', name: 'other.txt', size: '1', createdTime: 'now' }),
    );
    await expectProviderError(
      new GoogleDriveProvider(signedIn(), fast).upload(name, bytesOf(1)),
      'INVALID_RESPONSE',
    );
  });

  it('rejects a malformed Range header and an unexpected status reply', async () => {
    const big = bytesOf(2 * GDRIVE_CHUNK_BYTES, 1);
    const isChunk = (r: Request) =>
      r.method === 'PUT' && (r.headers.get('content-range') ?? '').startsWith('bytes 0-');

    const drive = new FakeDrive();
    server.use(...drive.handlers());
    drive.fail(
      isChunk,
      () => new HttpResponse(null, { status: 308, headers: { Range: 'nonsense' } }),
    );
    await expectProviderError(
      new GoogleDriveProvider(signedIn(), fast).upload(name, big),
      'INVALID_RESPONSE',
    );

    const drive2 = new FakeDrive();
    server.use(...drive2.handlers());
    drive2.fail(isChunk, () => HttpResponse.error());
    drive2.fail(
      (r) => r.method === 'PUT' && r.headers.get('content-range') === `bytes */${big.length}`,
      () => HttpResponse.json({}),
    );
    await expectProviderError(
      new GoogleDriveProvider(signedIn(), fast).upload(name, big),
      'INVALID_RESPONSE',
    );
  });

  it('gives up after repeated failed chunks', async () => {
    const drive = new FakeDrive();
    server.use(...drive.handlers());
    drive.fail(
      (r) => r.method === 'PUT' && (r.headers.get('content-range') ?? '').startsWith('bytes 0-'),
      () => new HttpResponse(null, { status: 503 }),
      10,
    );
    await expectProviderError(
      new GoogleDriveProvider(signedIn(), fast).upload(name, bytesOf(2 * GDRIVE_CHUNK_BYTES)),
      'UNAVAILABLE',
    );
    expect(drive.sessions.size).toBe(0);
  });
});

describe('OneDrive edge cases', () => {
  it('rejects a simple upload response that is not a drive item for a backup', async () => {
    const graph = new FakeGraph();
    server.use(...graph.handlers());
    graph.fail(
      (r) => r.method === 'PUT',
      () => HttpResponse.json({ id: 'x', name: 'other.txt', size: 1 }, { status: 201 }),
    );
    await expectProviderError(
      new OneDriveProvider(signedIn(), fast).upload(name, bytesOf(1)),
      'INVALID_RESPONSE',
    );
  });

  it('rejects a final fragment response that is not JSON metadata, and a bad status reply', async () => {
    const big = bytesOf(UPLOAD_CHUNK_BYTES + 5 * 1024 * 1024, 2);
    const graph = new FakeGraph();
    server.use(...graph.handlers());
    graph.fail(
      (r) => r.method === 'PUT' && r.url.startsWith(UPLOAD_HOST),
      () => HttpResponse.json({ unexpected: true }, { status: 201 }),
    );
    await expectProviderError(
      new OneDriveProvider(signedIn(), fast).upload(name, big),
      'INVALID_RESPONSE',
    );

    const graph2 = new FakeGraph();
    server.use(...graph2.handlers());
    graph2.fail(
      (r) => r.method === 'PUT' && r.url.startsWith(UPLOAD_HOST),
      () => HttpResponse.json({}, { status: 416 }),
    );
    graph2.fail(
      (r) => r.method === 'GET' && r.url.startsWith(UPLOAD_HOST),
      () => HttpResponse.json({ nextExpectedRanges: ['garbage'] }),
    );
    await expectProviderError(
      new OneDriveProvider(signedIn(), fast).upload(name, big),
      'INVALID_RESPONSE',
    );
  });

  it('reads the server offset when the last fragment is answered with 202', async () => {
    const big = bytesOf(UPLOAD_CHUNK_BYTES + 4 * 1024 * 1024, 3);
    const graph = new FakeGraph();
    server.use(...graph.handlers());
    let fragments = 0;
    server.use(
      http.put(`${UPLOAD_HOST}/up/:id`, () => {
        fragments++;
        // Pretend every fragment needs more data: the adapter must ask the session.
        return HttpResponse.json({ nextExpectedRanges: ['0-'] }, { status: 202 });
      }),
    );
    await expectProviderError(
      new OneDriveProvider(signedIn(), fast).upload(name, big),
      'UNAVAILABLE',
    );
    expect(fragments).toBeGreaterThan(2);
  });
});

describe('Dropbox edge cases', () => {
  it.each([
    ['path/insufficient_space/..', 'UNAVAILABLE'],
    ['path/conflict/file/..', 'CONFLICT'],
  ] as const)('maps upload error %s to %s', async (summary, code) => {
    const dropbox = new FakeDropbox();
    server.use(...dropbox.handlers());
    dropbox.fail(
      (r) => r.url.endsWith('/upload'),
      () => HttpResponse.json({ error_summary: summary }, { status: 409 }),
    );
    await expectProviderError(new DropboxProvider(signedIn(), fast).upload(name, bytesOf(1)), code);
  });

  it('rejects upload metadata that is not a backup file', async () => {
    const dropbox = new FakeDropbox();
    server.use(...dropbox.handlers());
    dropbox.fail(
      (r) => r.url.endsWith('/upload'),
      () => HttpResponse.json({ id: 'id:1', name: 'x.txt', size: 1, server_modified: 'now' }),
    );
    await expectProviderError(
      new DropboxProvider(signedIn(), fast).upload(name, bytesOf(1)),
      'INVALID_RESPONSE',
    );
  });
});
