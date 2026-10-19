import { ProviderError } from '@budget/backup';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGoogleSession,
  GIS_SCRIPT_URL,
  loadGis,
  resetGisForTests,
  type GoogleOAuth2,
} from './google-session';

type Callbacks = Parameters<GoogleOAuth2['initTokenClient']>[0];

/** Fake GIS: `respond` decides what the popup returns. */
function fakeGis(respond: (config: Callbacks) => void) {
  const configs: Callbacks[] = [];
  const oauth2: GoogleOAuth2 = {
    initTokenClient: (config) => {
      configs.push(config);
      return { requestAccessToken: () => respond(config) };
    },
    hasGrantedAllScopes: (response, ...scopes) =>
      scopes.every((s) => (response.scope ?? '').split(' ').includes(s)),
  };
  return { oauth2, configs, load: vi.fn(() => Promise.resolve(oauth2)) };
}

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const grant = (c: Callbacks) =>
  c.callback({ access_token: 'g-token', expires_in: 3599, scope: SCOPE });

async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).code).toBe(code);
}

afterEach(() => {
  resetGisForTests();
  document.head.replaceChildren();
  delete window.google;
});

describe('Google session (SEC-W13)', () => {
  it('requests only drive.appdata with the configured client and keeps the token in memory', async () => {
    const gis = fakeGis(grant);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const session = createGoogleSession({ clientId: 'cid', load: gis.load });

    await session.prepare?.();
    await session.signIn();

    expect(gis.configs[0]).toMatchObject({ client_id: 'cid', scope: SCOPE });
    expect(session.isSignedIn()).toBe(true);
    expect(await session.getAccessToken()).toBe('g-token');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('opens the sign-in synchronously from the click once prepared', async () => {
    const gis = fakeGis(grant);
    const session = createGoogleSession({ clientId: 'cid', load: gis.load });
    await session.prepare?.();

    const pending = session.signIn();
    // requestAccessToken already ran, before any await (user activation is still valid).
    expect(gis.configs).toHaveLength(1);
    await pending;
  });

  it('loads GIS on demand when not prepared', async () => {
    const gis = fakeGis(grant);
    const session = createGoogleSession({ clientId: 'cid', load: gis.load });
    await session.signIn();
    expect(gis.load).toHaveBeenCalledTimes(1);
  });

  it('expires the token a minute early, then asks to connect again', async () => {
    let t = 1_000_000;
    const gis = fakeGis(grant);
    const session = createGoogleSession({ clientId: 'cid', load: gis.load, now: () => t });
    await session.signIn();

    t += 3599_000 - 60_000 - 1;
    expect(await session.getAccessToken()).toBe('g-token');
    t += 1;
    expect(session.isSignedIn()).toBe(false);
    await expectCode(session.getAccessToken(), 'AUTH_REQUIRED');
  });

  it.each([
    [
      'the popup is closed',
      (c: Callbacks) => c.error_callback?.({ type: 'popup_closed' }),
      'CANCELLED',
    ],
    [
      'the popup is blocked',
      (c: Callbacks) => c.error_callback?.({ type: 'popup_failed_to_open' }),
      'CANCELLED',
    ],
    ['GIS fails', (c: Callbacks) => c.error_callback?.({ type: 'unknown' }), 'UNAVAILABLE'],
    ['consent is denied', (c: Callbacks) => c.callback({ error: 'access_denied' }), 'CANCELLED'],
    [
      'the Drive permission is unticked',
      (c: Callbacks) => c.callback({ access_token: 't', expires_in: 3599, scope: 'openid' }),
      'FORBIDDEN',
    ],
  ])('maps %s', async (_label, respond, code) => {
    const gis = fakeGis(respond);
    const session = createGoogleSession({ clientId: 'cid', load: gis.load });
    await expectCode(session.signIn(), code);
    expect(session.isSignedIn()).toBe(false);
  });

  it('reports a library that cannot load as UNAVAILABLE', async () => {
    const session = createGoogleSession({
      clientId: 'cid',
      load: () => Promise.reject(new Error('offline')),
    });
    await expectCode(session.signIn(), 'UNAVAILABLE');
  });

  it('sign-out forgets the token', async () => {
    const gis = fakeGis(grant);
    const session = createGoogleSession({ clientId: 'cid', load: gis.load });
    await session.signIn();
    await session.signOut();
    await expectCode(session.getAccessToken(), 'AUTH_REQUIRED');
  });
});

describe('loadGis', () => {
  it('adds the GIS script once and resolves with google.accounts.oauth2', async () => {
    const first = loadGis();
    const second = loadGis();
    const scripts = document.head.querySelectorAll('script');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.src).toBe(GIS_SCRIPT_URL);
    expect(scripts[0]?.referrerPolicy).toBe('no-referrer');

    const oauth2 = fakeGis(grant).oauth2;
    window.google = { accounts: { oauth2 } };
    scripts[0]?.dispatchEvent(new Event('load'));

    expect(await first).toBe(oauth2);
    expect(await second).toBe(oauth2);
  });

  it('rejects and allows a retry when the script fails to load', async () => {
    const attempt = loadGis();
    document.head.querySelector('script')?.dispatchEvent(new Event('error'));
    await expect(attempt).rejects.toThrow('GIS failed to load');
    expect(document.head.querySelector('script')).toBeNull();

    const retry = loadGis();
    expect(document.head.querySelectorAll('script')).toHaveLength(1);
    window.google = { accounts: {} };
    document.head.querySelector('script')?.dispatchEvent(new Event('load'));
    await expect(retry).rejects.toThrow('GIS did not initialize');
  });
});
