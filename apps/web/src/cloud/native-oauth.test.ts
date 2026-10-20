import { pkceChallenge, ProviderError } from '@budget/backup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeepLinkRouter } from '@/platform';

import { createNativeOAuthSession, redirectTarget, type NativeOAuthConfig } from './native-oauth';
import {
  DROPBOX_NATIVE_REDIRECT,
  GOOGLE_ANDROID_REDIRECT,
  googleIosRedirect,
  MICROSOFT_NATIVE_REDIRECT,
  nativeOAuthConfigs,
} from './native-providers';

const config: NativeOAuthConfig = {
  authorizeUrl: 'https://login.example/authorize',
  tokenUrl: 'https://login.example/token',
  clientId: 'client-1',
  redirectUri: 'com.astats.budget://auth/callback/test',
  scopes: ['files.read', 'files.write'],
  extraParams: { prompt: 'select_account' },
};

const tokenResponse = {
  status: 200,
  data: {
    access_token: 'at-1',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'files.read files.write',
  },
};

function setup(overrides: Partial<NativeOAuthConfig> = {}) {
  const router = new DeepLinkRouter();
  const closed = new Set<() => void>();
  const browser = {
    opened: [] as URL[],
    open: vi.fn((url: string) => {
      browser.opened.push(new URL(url));
      return Promise.resolve();
    }),
    close: vi.fn(() => Promise.resolve()),
    onClosed: vi.fn((handler: () => void) => {
      closed.add(handler);
      return () => closed.delete(handler);
    }),
    /** The user closes the browser (or Android reports it closed after the redirect). */
    finish: () => {
      for (const h of closed) h();
    },
  };
  const trips = vi.fn();
  const away = <T>(task: () => Promise<T>) => {
    trips();
    return task();
  };
  const postForm = vi.fn((_url: string, _form: Record<string, string>) =>
    Promise.resolve<{ status: number; data: unknown }>(tokenResponse),
  );
  let now = 1_000_000;
  const session = createNativeOAuthSession(
    { ...config, ...overrides },
    {
      platform: { onDeepLink: (path, h, scheme) => router.on(path, h, scheme), away },
      browser,
      postForm,
      now: () => now,
    },
  );
  /** The browser opened by the sign-in, once it is open. */
  const authorizeRequest = async () => {
    await vi.waitFor(() => {
      expect(browser.opened).toHaveLength(1);
    });
    return browser.opened[0] as URL;
  };
  const redirect = (query: string) =>
    router.dispatch(`${overrides.redirectUri ?? config.redirectUri}?${query}`);
  return {
    session,
    browser,
    trips,
    postForm,
    router,
    authorizeRequest,
    redirect,
    advance: (ms: number) => (now += ms),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('native OAuth sign-in (SEC-M05)', () => {
  it('runs code + PKCE in the system browser and redeems the code with native HTTP', async () => {
    const t = setup();
    const signIn = t.session.signIn();
    const url = await t.authorizeRequest();
    const params = Object.fromEntries(url.searchParams);

    expect(url.origin + url.pathname).toBe('https://login.example/authorize');
    expect(params).toMatchObject({
      client_id: 'client-1',
      response_type: 'code',
      redirect_uri: 'com.astats.budget://auth/callback/test',
      scope: 'files.read files.write',
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    expect(params.state).toMatch(/^[\w-]{22}$/);

    expect(t.redirect(`code=c-1&state=${params.state}`)).toBe(true);
    await signIn;

    const form = t.postForm.mock.calls[0]?.[1] ?? {};
    expect(t.postForm.mock.calls[0]?.[0]).toBe('https://login.example/token');
    expect(form).toMatchObject({
      grant_type: 'authorization_code',
      code: 'c-1',
      redirect_uri: 'com.astats.budget://auth/callback/test',
      client_id: 'client-1',
    });
    expect(await pkceChallenge(form.code_verifier ?? '')).toBe(params.code_challenge);
    expect(t.session.isSignedIn()).toBe(true);
    expect(await t.session.getAccessToken()).toBe('at-1');
    // The trip to the browser does not lock the app, and the browser is closed afterwards.
    expect(t.trips).toHaveBeenCalledOnce();
    expect(t.browser.close).toHaveBeenCalled();
  });

  it('rejects a redirect with another state and never redeems its code', async () => {
    const t = setup();
    const signIn = t.session.signIn();
    await t.authorizeRequest();

    t.redirect('code=forged&state=attacker-state');

    await expect(signIn).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(t.postForm).not.toHaveBeenCalled();
    expect(t.session.isSignedIn()).toBe(false);
  });

  it('ignores links on other paths and stops listening after the sign-in', async () => {
    const t = setup();
    const signIn = t.session.signIn();
    const state = (await t.authorizeRequest()).searchParams.get('state') ?? '';

    expect(t.router.dispatch(`com.astats.budget://auth/callback/other?code=x&state=${state}`)).toBe(
      false,
    );
    t.redirect(`code=c&state=${state}`);
    await signIn;

    expect(t.redirect(`code=again&state=${state}`)).toBe(false);
  });

  it.each(['error=access_denied', 'code='])('treats a redirect with %s as cancelled', async (q) => {
    const t = setup();
    const signIn = t.session.signIn();
    const state = (await t.authorizeRequest()).searchParams.get('state') ?? '';

    t.redirect(`${q}&state=${state}`);

    await expect(signIn).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('is cancelled when the browser closes without a redirect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t = setup();
    const signIn = t.session.signIn();
    await t.authorizeRequest();

    t.browser.finish();
    const rejected = expect(signIn).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(1500);
    await rejected;
  });

  it('accepts a redirect that arrives just after the browser reports closing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t = setup();
    const signIn = t.session.signIn();
    const state = (await t.authorizeRequest()).searchParams.get('state') ?? '';

    t.browser.finish();
    await vi.advanceTimersByTimeAsync(500);
    t.redirect(`code=c&state=${state}`);

    await expect(signIn).resolves.toBeUndefined();
  });

  it('times out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t = setup();
    const signIn = t.session.signIn();
    await t.authorizeRequest();

    const rejected = expect(signIn).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await rejected;
  });

  it('allows one sign-in per redirect at a time', async () => {
    const t = setup();
    const first = t.session.signIn();
    await t.authorizeRequest();

    await expect(t.session.signIn()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const state = t.browser.opened[0]?.searchParams.get('state') ?? '';
    t.redirect(`code=c&state=${state}`);
    await first;
  });

  it('reports a browser that cannot open', async () => {
    const t = setup();
    t.browser.open.mockRejectedValueOnce(new Error('no browser'));

    await expect(t.session.signIn()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it.each([
    ['a network failure', () => Promise.reject(new Error('offline')), 'NETWORK'],
    [
      'a rejected code',
      () => Promise.resolve({ status: 400, data: { error: 'invalid_grant' } }),
      'UNAVAILABLE',
    ],
    [
      'a malformed response',
      () => Promise.resolve({ status: 200, data: { token: 'x' } }),
      'UNAVAILABLE',
    ],
    [
      'missing permissions',
      () => Promise.resolve({ status: 200, data: { ...tokenResponse.data, scope: 'files.read' } }),
      'FORBIDDEN',
    ],
  ] as const)('fails on %s during code redemption', async (_name, response, code) => {
    const t = setup();
    t.postForm.mockImplementationOnce(response);
    const signIn = t.session.signIn();
    const state = (await t.authorizeRequest()).searchParams.get('state') ?? '';
    t.redirect(`code=c&state=${state}`);

    await expect(signIn).rejects.toEqual(expect.objectContaining({ code }));
    await expect(signIn).rejects.toBeInstanceOf(ProviderError);
    expect(t.session.isSignedIn()).toBe(false);
  });

  it('accepts a response without scope (RFC 6749 §5.1) and normalized scopes', async () => {
    const t = setup({ normalizeScope: (s) => s.replace(/^https:\/\/api\//, '') });
    t.postForm.mockResolvedValueOnce({
      status: 200,
      data: {
        ...tokenResponse.data,
        scope: 'https://api/FILES.READ https://api/files.write openid',
      },
    });
    const signIn = t.session.signIn();
    const state = (await t.authorizeRequest()).searchParams.get('state') ?? '';
    t.redirect(`code=c&state=${state}`);
    await signIn;

    expect(t.session.isSignedIn()).toBe(true);
  });

  it('forgets an expired token and on sign-out', async () => {
    const t = setup();
    const signIn = t.session.signIn();
    const state = (await t.authorizeRequest()).searchParams.get('state') ?? '';
    t.redirect(`code=c&state=${state}`);
    await signIn;

    t.advance(3600_000 - 60_000);
    await expect(t.session.getAccessToken()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(t.session.isSignedIn()).toBe(false);

    await t.session.signOut();
    expect(t.session.isSignedIn()).toBe(false);
  });
});

describe('native provider configuration', () => {
  it('registers redirects on the app scheme (Google iOS: reversed client id)', () => {
    expect(redirectTarget(MICROSOFT_NATIVE_REDIRECT)).toEqual({
      scheme: 'com.astats.budget',
      path: '/auth/callback/microsoft',
    });
    expect(redirectTarget(DROPBOX_NATIVE_REDIRECT).path).toBe('/auth/callback/dropbox');
    expect(redirectTarget(GOOGLE_ANDROID_REDIRECT)).toEqual({
      scheme: 'com.astats.budget',
      path: '/oauth2redirect',
    });
    expect(googleIosRedirect('123-abc.apps.googleusercontent.com')).toBe(
      'com.googleusercontent.apps.123-abc:/oauth2redirect',
    );
    expect(() => redirectTarget('not a uri')).toThrow();
  });

  it('configures only providers with a client id, and Google per platform', () => {
    const ids = {
      microsoft: 'ms',
      googleAndroid: 'ga',
      googleIos: 'gi.apps.googleusercontent.com',
    };

    const android = nativeOAuthConfigs({ id: 'android' }, ids);
    const ios = nativeOAuthConfigs({ id: 'ios' }, ids);

    expect(Object.keys(android)).toEqual(['onedrive', 'gdrive']);
    expect(android.gdrive?.clientId).toBe('ga');
    expect(ios.gdrive?.redirectUri).toBe('com.googleusercontent.apps.gi:/oauth2redirect');
    expect(nativeOAuthConfigs({ id: 'android' }, { dropbox: 'db' }).dropbox).toMatchObject({
      extraParams: { token_access_type: 'online' },
      redirectUri: 'com.astats.budget://auth/callback/dropbox',
    });
    expect(android.onedrive?.normalizeScope?.('https://graph.microsoft.com/Files.ReadWrite')).toBe(
      'Files.ReadWrite',
    );
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
