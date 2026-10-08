import { ONEDRIVE_SCOPES, ProviderError, type OAuthSession } from '@budget/backup';
import type { AccountInfo, IPublicClientApplication } from '@azure/msal-browser';

export interface MicrosoftSessionConfig {
  clientId: string;
  /** Must match the SPA redirect URI registered in Microsoft Entra ID. */
  redirectUri: string;
  /** `common` accepts personal and work/school accounts. */
  authority?: string;
}

/** MSAL error codes that mean "the user did not finish signing in". */
const CANCELLED = new Set(['user_cancelled', 'popup_window_error', 'empty_window_error']);

function mapError(err: unknown): ProviderError {
  const code = (err as { errorCode?: unknown } | null)?.errorCode;
  if (typeof code === 'string' && CANCELLED.has(code)) return new ProviderError('CANCELLED');
  if (code === 'no_network_connectivity' || code === 'network_error') {
    return new ProviderError('NETWORK');
  }
  return new ProviderError('UNAVAILABLE', 'Microsoft sign-in failed');
}

/**
 * OAuth for OneDrive with MSAL (authorization code + PKCE in a popup). Tokens stay in MSAL's
 * memory cache only (BUILD_PLAN §6.1): a reload or app lock means connecting again. MSAL is
 * loaded on first use, so it is not part of the initial bundle.
 */
export function createMicrosoftSession(config: MicrosoftSessionConfig): OAuthSession {
  let app: Promise<IPublicClientApplication> | null = null;
  let account: AccountInfo | null = null;
  const scopes = [...ONEDRIVE_SCOPES];

  const load = () =>
    (app ??= import('@azure/msal-browser').then((msal) =>
      msal.createStandardPublicClientApplication({
        auth: {
          clientId: config.clientId,
          authority: config.authority ?? 'https://login.microsoftonline.com/common',
          redirectUri: config.redirectUri,
        },
        cache: { cacheLocation: msal.BrowserCacheLocation.MemoryStorage },
        // No MSAL logging: log lines can contain account details.
        system: { loggerOptions: { loggerCallback: () => undefined, piiLoggingEnabled: false } },
      }),
    ));

  return {
    isSignedIn: () => account !== null,

    async signIn() {
      let msal: IPublicClientApplication;
      try {
        msal = await load();
      } catch {
        app = null;
        throw new ProviderError('UNAVAILABLE', 'Could not load Microsoft sign-in');
      }
      try {
        const result = await msal.loginPopup({ scopes, prompt: 'select_account' });
        account = result.account;
      } catch (err) {
        throw mapError(err);
      }
    },

    async getAccessToken() {
      if (!account) throw new ProviderError('AUTH_REQUIRED');
      try {
        // Uses the in-memory cache, refreshing with the in-memory refresh token when needed.
        const result = await (await load()).acquireTokenSilent({ scopes, account });
        return result.accessToken;
      } catch {
        account = null;
        throw new ProviderError('AUTH_REQUIRED');
      }
    },

    async signOut() {
      const current = account;
      account = null;
      if (app && current) await (await app).clearCache({ account: current }).catch(() => undefined);
    },
  };
}
