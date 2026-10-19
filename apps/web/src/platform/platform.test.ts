import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capacitor = vi.hoisted(() => ({ native: false, platform: 'web' }));
const appUrlOpen = vi.hoisted(() => ({ listener: null as null | ((e: { url: string }) => void) }));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => capacitor.native,
    getPlatform: () => capacitor.platform,
  },
}));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((event: string, listener: (e: { url: string }) => void) => {
      if (event === 'appUrlOpen') appUrlOpen.listener = listener;
      return Promise.resolve({ remove: () => Promise.resolve() });
    }),
  },
}));
vi.mock('@/lib/download', () => ({ downloadFile: vi.fn() }));

const { downloadFile } = await import('@/lib/download');
const { createPlatform, PlatformUnsupportedError } = await import('./index');

beforeEach(() => {
  appUrlOpen.listener = null;
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
    expect(downloadFile).toHaveBeenCalledWith('a.csv', 'x,y', 'text/csv');
    expect(appUrlOpen.listener).toBeNull();
  });

  it('accepts deep-link handlers but never calls them', () => {
    const handler = vi.fn();
    const off = createPlatform().onDeepLink('/open', handler);

    expect(off).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe.each(['android', 'ios'] as const)('createPlatform on %s', (id) => {
  beforeEach(() => {
    Object.assign(capacitor, { native: true, platform: id });
  });

  it('is native', () => {
    const platform = createPlatform();

    expect(platform.id).toBe(id);
    expect(platform.isNative()).toBe(true);
  });

  it('routes app links from appUrlOpen to the handler of their path only', () => {
    const platform = createPlatform();
    const callback = vi.fn();
    const other = vi.fn();
    platform.onDeepLink('/auth/callback/dropbox', callback);
    platform.onDeepLink('/open', other);

    appUrlOpen.listener?.({ url: 'com.astats.budget:/auth/callback/dropbox?code=c&state=s' });
    appUrlOpen.listener?.({ url: 'https://evil.example/auth/callback/dropbox?code=x' });
    appUrlOpen.listener?.({ url: 'com.astats.budget:/elsewhere?code=y' });

    expect(callback).toHaveBeenCalledOnce();
    expect((callback.mock.calls[0]?.[0] as URLSearchParams).get('state')).toBe('s');
    expect(other).not.toHaveBeenCalled();
  });

  it('does not save files yet (Step 4.3) and never falls back to a Blob download', async () => {
    await expect(
      createPlatform().saveFile({ name: 'a.csv', content: 'x', type: 'text/csv' }),
    ).rejects.toBeInstanceOf(PlatformUnsupportedError);
    expect(downloadFile).not.toHaveBeenCalled();
  });
});

it('treats an unknown native platform as the web', () => {
  Object.assign(capacitor, { native: true, platform: 'electron' });

  expect(createPlatform().id).toBe('web');
});
