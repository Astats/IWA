import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capacitor = vi.hoisted(() => ({ native: false, platform: 'web' }));
const app = vi.hoisted(() => ({
  listeners: new Map<string, Array<(e: { url: string }) => void>>(),
}));
const fs = vi.hoisted(() => ({
  writeFile: vi.fn((_: unknown) => Promise.resolve({ uri: 'file:///cache/exports/a.csv' })),
  rmdir: vi.fn((_: unknown) => Promise.resolve()),
}));
const share = vi.hoisted(() => ({ share: vi.fn((_: unknown) => Promise.resolve({})) }));
const browser = vi.hoisted(() => ({
  open: vi.fn((_: unknown) => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  finished: null as null | (() => void),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => capacitor.native,
    getPlatform: () => capacitor.platform,
  },
}));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((event: string, listener: (e: { url: string }) => void) => {
      app.listeners.set(event, [...(app.listeners.get(event) ?? []), listener]);
      return Promise.resolve({ remove: () => Promise.resolve() });
    }),
  },
}));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: fs,
}));
vi.mock('@capacitor/share', () => ({ Share: share }));
vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: browser.open,
    close: browser.close,
    addListener: vi.fn((_: string, handler: () => void) => {
      browser.finished = handler;
      return Promise.resolve({ remove: () => Promise.resolve() });
    }),
  },
}));
vi.mock('@/lib/download', () => ({ downloadFile: vi.fn() }));

const { downloadFile } = await import('@/lib/download');
const { createPlatform } = await import('./index');
const { safeFileName } = await import('./native-platform');

const emit = (event: string, payload = { url: '' }) => {
  for (const listener of app.listeners.get(event) ?? []) listener(payload);
};

beforeEach(() => {
  app.listeners.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  Object.assign(capacitor, { native: false, platform: 'web' });
});

describe('createPlatform on the web', () => {
  it('is the browser platform and saves files as downloads', async () => {
    const platform = createPlatform();

    await platform.saveFile({ name: 'a.csv', content: 'x,y', type: 'text/csv' });

    expect(platform.id).toBe('web');
    expect(platform.isNative()).toBe(false);
    expect(platform.authBrowser).toBeUndefined();
    expect(downloadFile).toHaveBeenCalledWith('a.csv', 'x,y', 'text/csv');
    expect(app.listeners.size).toBe(0);
  });

  it('accepts deep-link and background handlers but never calls them', async () => {
    const handler = vi.fn();
    const platform = createPlatform();
    const offLink = platform.onDeepLink('/open', handler);
    const offBackground = platform.onBackground(handler);

    expect(offLink).not.toThrow();
    expect(offBackground).not.toThrow();
    await expect(platform.away(() => Promise.resolve(7))).resolves.toBe(7);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('createPlatform on Android', () => {
  const id = 'android';
  beforeEach(() => {
    Object.assign(capacitor, { native: true, platform: id });
  });

  it('is native and clears export files left from a previous run', () => {
    const platform = createPlatform();

    expect(platform.id).toBe(id);
    expect(platform.isNative()).toBe(true);
    expect(fs.rmdir).toHaveBeenCalledWith({ path: 'exports', directory: 'CACHE', recursive: true });
  });

  it('routes app links from appUrlOpen to the handler of their path only', () => {
    const platform = createPlatform();
    const callback = vi.fn();
    const other = vi.fn();
    platform.onDeepLink('/auth/callback/dropbox', callback);
    platform.onDeepLink('/open', other);

    emit('appUrlOpen', { url: 'com.astats.budget:/auth/callback/dropbox?code=c&state=s' });
    emit('appUrlOpen', { url: 'https://evil.example/auth/callback/dropbox?code=x' });
    emit('appUrlOpen', { url: 'com.astats.budget:/elsewhere?code=y' });

    expect(callback).toHaveBeenCalledOnce();
    expect((callback.mock.calls[0]?.[0] as URLSearchParams).get('state')).toBe('s');
    expect(other).not.toHaveBeenCalled();
  });

  it('shares text files from the cache through the share sheet', async () => {
    await createPlatform().saveFile({ name: 'a.csv', content: 'x,y', type: 'text/csv' });

    expect(fs.writeFile).toHaveBeenCalledWith({
      path: 'exports/a.csv',
      directory: 'CACHE',
      recursive: true,
      data: 'x,y',
      encoding: 'utf8',
    });
    expect(share.share).toHaveBeenCalledWith({
      title: 'a.csv',
      files: ['file:///cache/exports/a.csv'],
    });
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('writes binary files as base64 and clears older exports first', async () => {
    const platform = createPlatform();
    fs.rmdir.mockClear();

    await platform.saveFile({
      name: 'budget.bgtb',
      content: new Uint8Array([0, 255, 1]),
      type: 'application/octet-stream',
    });

    expect(fs.rmdir).toHaveBeenCalledOnce();
    expect(fs.writeFile.mock.calls[0]?.[0]).toMatchObject({
      path: 'exports/budget.bgtb',
      data: 'AP8B',
    });
    expect(fs.writeFile.mock.calls[0]?.[0]).not.toHaveProperty('encoding');
  });

  it('treats a cancelled share sheet as done but reports other failures', async () => {
    const platform = createPlatform();
    share.share.mockRejectedValueOnce(new Error('Share canceled'));
    await expect(
      platform.saveFile({ name: 'a.csv', content: 'x', type: 'text/csv' }),
    ).resolves.toBeUndefined();

    share.share.mockRejectedValueOnce(new Error('Error sharing item'));
    await expect(
      platform.saveFile({ name: 'a.csv', content: 'x', type: 'text/csv' }),
    ).rejects.toThrow('Error sharing item');
  });

  it('locks and clears exports when the app goes to the background', () => {
    const platform = createPlatform();
    const onLock = vi.fn();
    platform.onBackground(onLock);
    fs.rmdir.mockClear();

    emit('pause');

    expect(onLock).toHaveBeenCalledOnce();
    expect(fs.rmdir).toHaveBeenCalledOnce();
  });

  it('does not lock while the share sheet is open', async () => {
    const platform = createPlatform();
    const onLock = vi.fn();
    platform.onBackground(onLock);
    let finishShare!: () => void;
    share.share.mockImplementationOnce(
      () => new Promise((resolve) => (finishShare = () => resolve({}))),
    );

    const saving = platform.saveFile({ name: 'a.csv', content: 'x', type: 'text/csv' });
    await vi.waitFor(() => {
      expect(share.share).toHaveBeenCalled();
    });
    emit('pause');
    emit('resume');
    finishShare();
    await saving;

    expect(onLock).not.toHaveBeenCalled();
  });

  it('opens and closes the system browser for sign-in', async () => {
    const auth = createPlatform().authBrowser;
    const closed = vi.fn();
    auth?.onClosed(closed);

    await auth?.open('https://login.example/authorize');
    await auth?.close();
    browser.finished?.();
    emit('resume'); // back in the app without a redirect also counts as closed

    expect(browser.open).toHaveBeenCalledWith({ url: 'https://login.example/authorize' });
    expect(browser.close).toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(2);
  });
});

describe('safeFileName', () => {
  it.each([
    ['budget-2026-10-19.csv', 'budget-2026-10-19.csv'],
    ['../../etc/passwd', '__.._etc_passwd'],
    ['a b/c\\d.csv', 'a_b_c_d.csv'],
    ['.hidden', '_hidden'],
    ['', 'export'],
  ])('%s → %s', (name, safe) => {
    expect(safeFileName(name)).toBe(safe);
  });
});

it('treats an unknown native platform as the web', () => {
  Object.assign(capacitor, { native: true, platform: 'electron' });

  expect(createPlatform().id).toBe('web');
});
