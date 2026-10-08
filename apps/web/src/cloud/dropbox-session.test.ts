import { pkceChallenge, ProviderError } from '@budget/backup';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDropboxSession } from './dropbox-session';
import { waitForRedirect, type PopupDeps } from './oauth-popup';

const REDIRECT = 'http://localhost/auth/callback/dropbox';
const SCOPES = 'files.metadata.read files.content.read files.content.write';

type Respond = (authorizeUrl: URL, post: (data: unknown) => void, popup: FakePopup) => void;

interface FakePopup {
  closed: boolean;
  urls: string[];
  close(): void;
  location: { href: string };
}

/** Fake popup + channel: navigating the popup triggers `respond` like a provider would. */
function popupDeps(respond: Respond, overrides: Partial<PopupDeps> = {}) {
  const channel = { onmessage: null as ((e: MessageEvent) => void) | null, close: vi.fn() };
  const post = (data: unknown) => channel.onmessage?.({ data } as MessageEvent);
  const popup: FakePopup = {
    closed: false,
    urls: [],
    close() {
      this.closed = true;
    },
    location: {
      set href(url: string) {
        popup.urls.push(url);
        queueMicrotask(() => {
          respond(new URL(url), post, popup);
        });
      },
      get href() {
        return popup.urls.at(-1) ?? 'about:blank';
      },
    },
  };
  const deps: PopupDeps = {
    open: vi.fn(() => popup as unknown as Window),
    channel: () => channel,
    pollMs: 5,
    closeGraceMs: 10,
    ...overrides,
  };
  return { deps, popup, channel };
}

const approve: Respond = (url, post) => {
  post({ state: url.searchParams.get('state'), code: 'the-code' });
};

function tokenFetch(
  body: unknown = {
    access_token: 'dbx-token',
    token_type: 'bearer',
    expires_in: 14400,
    scope: SCOPES,
  },
  status = 200,
) {
  const requests: Array<{ url: string; body: string }> = [];
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    requests.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
    return Promise.resolve(Response.json(body, { status }));
  });
  return { fetch, requests };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).code).toBe(code);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Dropbox session (SEC-W13)', () => {
  it('uses PKCE S256, a state, the minimal scopes and short-lived tokens', async () => {
    const { deps, popup } = popupDeps(approve);
    const http = tokenFetch();
    const session = createDropboxSession({
      appKey: 'app-key',
      redirectUri: REDIRECT,
      popup: deps,
      http: { fetch: http.fetch },
    });

    await session.signIn();

    const url = new URL(popup.urls[0]!);
    expect(`${url.origin}${url.pathname}`).toBe('https://www.dropbox.com/oauth2/authorize');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe('app-key');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toBe(REDIRECT);
    expect(q.get('token_access_type')).toBe('online');
    expect(q.get('scope')).toBe(SCOPES);
    expect(q.get('state')).toMatch(/^[\w-]{22}$/);

    // The token request proves possession of the verifier behind the challenge.
    const form = new URLSearchParams(http.requests[0]!.body);
    expect(http.requests[0]!.url).toBe('https://api.dropboxapi.com/oauth2/token');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('client_id')).toBe('app-key');
    expect(form.get('redirect_uri')).toBe(REDIRECT);
    expect(await pkceChallenge(form.get('code_verifier') ?? '')).toBe(q.get('code_challenge'));
    expect(form.has('client_secret')).toBe(false);

    expect(session.isSignedIn()).toBe(true);
    expect(await session.getAccessToken()).toBe('dbx-token');
  });

  it('opens the popup synchronously from the click', () => {
    const { deps } = popupDeps(approve);
    const session = createDropboxSession({
      appKey: 'k',
      redirectUri: REDIRECT,
      popup: deps,
      http: { fetch: tokenFetch().fetch },
    });
    void session.signIn();
    expect(deps.open).toHaveBeenCalledTimes(1);
  });

  it('rejects a redirect with the wrong state and never exchanges the code', async () => {
    const { deps, popup } = popupDeps((_url, post) => {
      post({ state: 'forged-state', code: 'attacker-code' });
    });
    const http = tokenFetch();
    const session = createDropboxSession({
      appKey: 'k',
      redirectUri: REDIRECT,
      popup: deps,
      http: { fetch: http.fetch },
    });

    await expectCode(session.signIn(), 'UNAVAILABLE');
    expect(http.fetch).not.toHaveBeenCalled();
    expect(popup.closed).toBe(true);
    expect(session.isSignedIn()).toBe(false);
  });

  const deny: Respond = (url, post) => {
    post({ state: url.searchParams.get('state'), error: 'access_denied' });
  };
  const closePopup: Respond = (_url, _post, popup) => {
    popup.close();
  };

  it.each([
    ['the user denies access', deny],
    ['the user closes the popup', closePopup],
  ])('is CANCELLED when %s', async (_label, respond) => {
    const { deps } = popupDeps(respond);
    const session = createDropboxSession({
      appKey: 'k',
      redirectUri: REDIRECT,
      popup: deps,
      http: { fetch: tokenFetch().fetch },
    });
    await expectCode(session.signIn(), 'CANCELLED');
  });

  it('is CANCELLED when the popup is blocked', async () => {
    const { deps } = popupDeps(approve, { open: () => null });
    const session = createDropboxSession({ appKey: 'k', redirectUri: REDIRECT, popup: deps });
    await expectCode(session.signIn(), 'CANCELLED');
  });

  it('a malformed redirect message is rejected', async () => {
    const { deps } = popupDeps((_url, post) => {
      post({ state: 1 });
    });
    const session = createDropboxSession({ appKey: 'k', redirectUri: REDIRECT, popup: deps });
    await expectCode(session.signIn(), 'UNAVAILABLE');
  });

  it('a rejected code exchange or missing permissions fail the sign-in', async () => {
    const bad = createDropboxSession({
      appKey: 'k',
      redirectUri: REDIRECT,
      popup: popupDeps(approve).deps,
      http: { fetch: tokenFetch({ error: 'invalid_grant' }, 400).fetch },
    });
    await expectCode(bad.signIn(), 'UNAVAILABLE');

    const partial = createDropboxSession({
      appKey: 'k',
      redirectUri: REDIRECT,
      popup: popupDeps(approve).deps,
      http: {
        fetch: tokenFetch({
          access_token: 't',
          token_type: 'bearer',
          expires_in: 14400,
          scope: 'files.metadata.read',
        }).fetch,
      },
    });
    await expectCode(partial.signIn(), 'FORBIDDEN');
    expect(partial.isSignedIn()).toBe(false);
  });

  it('expires the token a minute early, and sign-out forgets it', async () => {
    let t = 0;
    const session = createDropboxSession({
      appKey: 'k',
      redirectUri: REDIRECT,
      popup: popupDeps(approve).deps,
      http: { fetch: tokenFetch().fetch },
      now: () => t,
    });
    await session.signIn();
    t = 14400_000 - 60_000 - 1;
    expect(await session.getAccessToken()).toBe('dbx-token');
    t += 1;
    await expectCode(session.getAccessToken(), 'AUTH_REQUIRED');

    t = 0;
    await session.signIn();
    await session.signOut();
    await expectCode(session.getAccessToken(), 'AUTH_REQUIRED');
  });
});

describe('waitForRedirect', () => {
  it('times out as CANCELLED', async () => {
    const { deps, popup } = popupDeps(() => undefined, { timeoutMs: 20 });
    await expectCode(waitForRedirect('s', popup as unknown as Window, deps), 'CANCELLED');
  });

  it('accepts a late message within the grace period after the popup closed', async () => {
    const { deps, popup, channel } = popupDeps(() => undefined, { closeGraceMs: 200 });
    const pending = waitForRedirect('s', popup as unknown as Window, deps);
    popup.close();
    await new Promise((r) => setTimeout(r, 20));
    channel.onmessage?.({ data: { state: 's', code: 'late' } } as MessageEvent);
    expect(await pending).toBe('late');
    expect(channel.close).toHaveBeenCalled();
  });
});
