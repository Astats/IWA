import { createPkce, ProviderError, randomState, type OAuthSession } from '@budget/backup';
import { z } from 'zod';

import { APP_URL_SCHEME, parseDeepLink, type AuthBrowser, type PlatformService } from '@/platform';

/*
 * OAuth on Android (BUILD_PLAN 4.3, SEC-M05): authorization code + PKCE in the system browser
 * (Custom Tabs, never a WebView), back into the app through a
 * custom-scheme deep link whose `state` must match. The code is redeemed with native HTTP: no
 * `Origin` header, which Microsoft requires for mobile clients (cross-origin redemption is for
 * SPAs only). Tokens stay in memory; there is no refresh token.
 */

/** A form POST outside the WebView (src/cloud/native-http.ts). */
export type PostForm = (
  url: string,
  form: Record<string, string>,
) => Promise<{ status: number; data: unknown }>;

export interface NativeOAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  /** Registered redirect URI on the app's scheme (`com.astats.budget:`). */
  redirectUri: string;
  scopes: readonly string[];
  /** Provider-specific authorization parameters (e.g. `prompt`). */
  extraParams?: Record<string, string>;
  /** Maps a granted scope to the form of `scopes` (e.g. strips Graph's resource prefix). */
  normalizeScope?: (scope: string) => string;
}

export interface NativeOAuthDeps {
  platform: Pick<PlatformService, 'onDeepLink' | 'away'>;
  browser: AuthBrowser;
  postForm: PostForm;
  now?: () => number;
  /** After the browser closes, how long a late redirect may still arrive. */
  closeGraceMs?: number;
  timeoutMs?: number;
}

const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.coerce.number().int().positive(),
  scope: z.string().max(4000).optional(),
});

/** Tokens are treated as expired a minute early, so a request never starts with a dying token. */
const EXPIRY_MARGIN_MS = 60_000;

/** The app-link path a redirect URI arrives on. */
export function redirectPath(redirectUri: string): string {
  const link = parseDeepLink(redirectUri, APP_URL_SCHEME);
  if (!link) throw new Error(`Not a ${APP_URL_SCHEME}: redirect URI: ${redirectUri}`);
  return link.path;
}

export function createNativeOAuthSession(
  config: NativeOAuthConfig,
  deps: NativeOAuthDeps,
): OAuthSession {
  const { closeGraceMs = 1500, timeoutMs = 10 * 60_000 } = deps;
  const now = deps.now ?? (() => Date.now());
  const normalize = (s: string) => (config.normalizeScope ?? ((x) => x))(s).toLowerCase();
  const path = redirectPath(config.redirectUri);
  let token: { value: string; expiresAt: number } | null = null;

  const valid = () => token !== null && now() < token.expiresAt;

  /** Opens the browser and resolves with the authorization code from the matching redirect. */
  function waitForCode(url: string, state: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const cleanups: Array<() => void> = [];
      let grace: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: { code: string } | { error: ProviderError }) => {
        clearTimeout(grace);
        for (const cleanup of cleanups.splice(0)) cleanup();
        if ('code' in result) resolve(result.code);
        else reject(result.error);
      };
      try {
        cleanups.push(
          deps.platform.onDeepLink(path, (params) => {
            const code = params.get('code');
            // A redirect for another sign-in (or a forged one) is rejected: CSRF protection.
            if (params.get('state') !== state) {
              finish({ error: new ProviderError('UNAVAILABLE', 'OAuth state mismatch') });
            } else if (params.get('error') || !code || code.length > 4096) {
              finish({ error: new ProviderError('CANCELLED') });
            } else {
              finish({ code });
            }
          }),
        );
      } catch {
        reject(new ProviderError('UNAVAILABLE', 'Another sign-in is in progress'));
        return;
      }
      cleanups.push(
        deps.browser.onClosed(() => {
          clearTimeout(grace);
          grace = setTimeout(() => {
            finish({ error: new ProviderError('CANCELLED') });
          }, closeGraceMs);
        }),
      );
      const timer = setTimeout(() => {
        finish({ error: new ProviderError('CANCELLED', 'Sign-in timed out') });
      }, timeoutMs);
      cleanups.push(() => {
        clearTimeout(timer);
      });
      deps.browser.open(url).catch(() => {
        finish({ error: new ProviderError('UNAVAILABLE', 'Could not open the browser') });
      });
    });
  }

  async function redeem(code: string, verifier: string): Promise<void> {
    let response: { status: number; data: unknown };
    try {
      response = await deps.postForm(config.tokenUrl, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        code_verifier: verifier,
      });
    } catch {
      throw new ProviderError('NETWORK');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderError('UNAVAILABLE', 'Code exchange failed');
    }
    const parsed = tokenSchema.safeParse(response.data);
    if (!parsed.success) throw new ProviderError('UNAVAILABLE', 'Malformed token response');
    // RFC 6749 §5.1: an omitted scope means the requested scopes were granted.
    if (parsed.data.scope !== undefined) {
      const granted = new Set(parsed.data.scope.split(/\s+/).map(normalize));
      if (!config.scopes.every((s) => granted.has(normalize(s)))) {
        throw new ProviderError('FORBIDDEN', 'Permissions not granted');
      }
    }
    token = {
      value: parsed.data.access_token,
      expiresAt: now() + parsed.data.expires_in * 1000 - EXPIRY_MARGIN_MS,
    };
  }

  return {
    isSignedIn: valid,

    async signIn() {
      const pkce = await createPkce();
      const state = randomState();
      const url = new URL(config.authorizeUrl);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        redirect_uri: config.redirectUri,
        scope: config.scopes.join(' '),
        state,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        ...config.extraParams,
      }).toString();
      // Leaving for the browser must not lock the app (src/platform/background-lock.ts).
      const code = await deps.platform.away(async () => {
        try {
          return await waitForCode(url.toString(), state);
        } finally {
          await deps.browser.close();
        }
      });
      await redeem(code, pkce.verifier);
    },

    getAccessToken() {
      if (!token || !valid()) {
        token = null;
        return Promise.reject(new ProviderError('AUTH_REQUIRED'));
      }
      return Promise.resolve(token.value);
    },

    signOut() {
      token = null;
      return Promise.resolve();
    },
  };
}
