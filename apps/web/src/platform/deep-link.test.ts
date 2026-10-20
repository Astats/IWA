import { describe, expect, it, vi } from 'vitest';

import { APP_URL_SCHEME, DeepLinkRouter, MAX_DEEP_LINK_LENGTH, parseDeepLink } from './deep-link';

describe('parseDeepLink', () => {
  it.each([
    ['com.astats.budget:/auth/callback/dropbox?code=abc&state=xyz', '/auth/callback/dropbox'],
    ['com.astats.budget://auth/callback/dropbox?code=abc&state=xyz', '/auth/callback/dropbox'],
    ['COM.ASTATS.BUDGET:/auth/callback/dropbox?code=abc&state=xyz', '/auth/callback/dropbox'],
  ])('reads the path and query of %s', (raw, path) => {
    const link = parseDeepLink(raw);

    expect(link?.path).toBe(path);
    expect(link?.params.get('code')).toBe('abc');
    expect(link?.params.get('state')).toBe('xyz');
  });

  it('ignores the fragment', () => {
    expect(parseDeepLink('com.astats.budget:/open?a=1#b=2')?.params.has('b')).toBe(false);
  });

  it.each([
    'https://localhost/auth/callback/dropbox?code=abc',
    'http://com.astats.budget/auth/callback/dropbox',
    // Built at runtime: a literal script URL trips no-script-url.
    ['javascript', 'alert(1)'].join(':'),
    'com.astats.budget.evil:/auth/callback/dropbox',
    'com.other.app:/auth/callback/dropbox',
    'com.astats.budget://user:pass@auth/callback/dropbox',
    'com.astats.budget://auth:8080/callback/dropbox',
    'not a url',
    '',
  ])('rejects %s', (raw) => {
    expect(parseDeepLink(raw)).toBeNull();
  });

  it('rejects links over the length limit', () => {
    const raw = `${APP_URL_SCHEME}:/open?x=${'a'.repeat(MAX_DEEP_LINK_LENGTH)}`;

    expect(parseDeepLink(raw)).toBeNull();
  });
});

describe('DeepLinkRouter', () => {
  it('hands the query to the handler of the exact path', () => {
    const router = new DeepLinkRouter();
    const handler = vi.fn();
    router.on('/auth/callback/dropbox', handler);

    expect(router.dispatch('com.astats.budget:/auth/callback/dropbox?code=c1&state=s1')).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(Object.fromEntries(handler.mock.calls[0]?.[0] as URLSearchParams)).toEqual({
      code: 'c1',
      state: 's1',
    });
  });

  it.each([
    'com.astats.budget:/auth/callback/dropbox/extra?code=c1',
    'com.astats.budget:/auth/callback/Dropbox?code=c1',
    'com.astats.budget:/auth/callback/microsoft?code=c1',
    'https://localhost/auth/callback/dropbox?code=c1',
  ])('drops %s', (raw) => {
    const router = new DeepLinkRouter();
    const handler = vi.fn();
    router.on('/auth/callback/dropbox', handler);

    expect(router.dispatch(raw)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('drops links after the handler is removed', () => {
    const router = new DeepLinkRouter();
    const handler = vi.fn();
    const off = router.on('/auth/callback/dropbox', handler);
    off();

    expect(router.dispatch('com.astats.budget:/auth/callback/dropbox?code=c1')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('allows one handler per path, and a stale unsubscribe keeps the newer handler', () => {
    const router = new DeepLinkRouter();
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = router.on('/open', first);

    expect(() => router.on('/open', second)).toThrow(/already exists/);

    offFirst();
    router.on('/open', second);
    offFirst();
    router.dispatch('com.astats.budget:/open');

    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });
});
