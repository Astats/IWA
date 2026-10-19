import { ProviderError } from '@budget/backup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMicrosoftSession } from './microsoft-session';

const msal = vi.hoisted(() => ({
  configs: [] as unknown[],
  loginPopup: vi.fn(),
  acquireTokenSilent: vi.fn(),
  clearCache: vi.fn(() => Promise.resolve()),
}));

vi.mock('@azure/msal-browser', () => ({
  BrowserCacheLocation: { MemoryStorage: 'memoryStorage' },
  createStandardPublicClientApplication: (config: unknown) => {
    msal.configs.push(config);
    return Promise.resolve({
      loginPopup: msal.loginPopup,
      acquireTokenSilent: msal.acquireTokenSilent,
      clearCache: msal.clearCache,
    });
  },
}));

const account = { homeAccountId: 'acc-1', username: 'someone@example.com' };
const config = { clientId: 'client-id', redirectUri: 'http://localhost/auth/callback/microsoft' };

async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).code).toBe(code);
}

beforeEach(() => {
  msal.configs.length = 0;
  msal.loginPopup.mockResolvedValue({ account, accessToken: 'login-token' });
  msal.acquireTokenSilent.mockResolvedValue({ accessToken: 'access-token' });
});

describe('Microsoft session (SEC-W13)', () => {
  it('keeps tokens in memory, uses the popup with the minimal scope', async () => {
    const session = createMicrosoftSession(config);
    expect(session.isSignedIn()).toBe(false);

    await session.signIn();

    expect(msal.configs).toEqual([
      expect.objectContaining({
        auth: {
          clientId: 'client-id',
          authority: 'https://login.microsoftonline.com/common',
          redirectUri: 'http://localhost/auth/callback/microsoft',
        },
        cache: { cacheLocation: 'memoryStorage' },
      }),
    ]);
    expect(msal.loginPopup).toHaveBeenCalledWith({
      scopes: ['Files.ReadWrite.AppFolder'],
      prompt: 'select_account',
    });
    expect(session.isSignedIn()).toBe(true);
    expect(await session.getAccessToken()).toBe('access-token');
    expect(msal.acquireTokenSilent).toHaveBeenCalledWith({
      scopes: ['Files.ReadWrite.AppFolder'],
      account,
    });
  });

  it('never writes to Web Storage', async () => {
    const setLocal = vi.spyOn(Storage.prototype, 'setItem');
    const session = createMicrosoftSession(config);
    await session.signIn();
    await session.getAccessToken();
    await session.signOut();
    expect(setLocal).not.toHaveBeenCalled();
  });

  it.each([
    ['user_cancelled', 'CANCELLED'],
    ['popup_window_error', 'CANCELLED'],
    ['empty_window_error', 'CANCELLED'],
    ['no_network_connectivity', 'NETWORK'],
    ['something_else', 'UNAVAILABLE'],
  ])('maps sign-in error %s to %s', async (errorCode, code) => {
    msal.loginPopup.mockRejectedValueOnce({ errorCode });
    const session = createMicrosoftSession(config);
    await expectCode(session.signIn(), code);
    expect(session.isSignedIn()).toBe(false);
  });

  it('a failed silent token request ends the session', async () => {
    const session = createMicrosoftSession(config);
    await session.signIn();
    msal.acquireTokenSilent.mockRejectedValueOnce({ errorCode: 'interaction_required' });

    await expectCode(session.getAccessToken(), 'AUTH_REQUIRED');
    expect(session.isSignedIn()).toBe(false);
  });

  it('requires sign-in before handing out tokens', async () => {
    await expectCode(createMicrosoftSession(config).getAccessToken(), 'AUTH_REQUIRED');
  });

  it('sign-out clears the account from the MSAL memory cache', async () => {
    const session = createMicrosoftSession(config);
    await session.signIn();
    await session.signOut();
    expect(msal.clearCache).toHaveBeenCalledWith({ account });
    expect(session.isSignedIn()).toBe(false);
    // Signing out twice is harmless.
    await session.signOut();
    expect(msal.clearCache).toHaveBeenCalledTimes(1);
  });

  it('loads MSAL once', async () => {
    const session = createMicrosoftSession(config);
    await session.signIn();
    await session.getAccessToken();
    await session.signIn();
    expect(msal.configs).toHaveLength(1);
  });
});
