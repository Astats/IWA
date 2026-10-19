import {
  createPkce,
  DROPBOX_API,
  DROPBOX_SCOPES,
  HttpClient,
  ProviderError,
  randomState,
  type HttpClientOptions,
  type OAuthSession,
} from '@budget/backup';
import { z } from 'zod';

import { browserPopupDeps, waitForRedirect, type PopupDeps } from './oauth-popup';

export const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';

export interface DropboxSessionConfig {
  /** Dropbox app key (public client id; the app has no secret). */
  appKey: string;
  /** Must match a redirect URI registered for the Dropbox app. */
  redirectUri: string;
  popup?: PopupDeps;
  http?: HttpClientOptions;
  now?: () => number;
}

const tokenSchema = z.object({
  access_token: z.string().min(1).max(4096),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive(),
  scope: z.string().max(2000).optional(),
});

/** Tokens are treated as expired a minute early, so a request never starts with a dying token. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Dropbox OAuth 2 authorization code flow with PKCE for a public client (BUILD_PLAN 3.4).
 * `token_access_type=online` asks for a short-lived access token only (no refresh token), which
 * stays in memory; when it expires the user connects again.
 */
export function createDropboxSession(config: DropboxSessionConfig): OAuthSession {
  const popupDeps = config.popup ?? browserPopupDeps;
  const http = new HttpClient(config.http);
  const now = config.now ?? (() => Date.now());
  let token: { value: string; expiresAt: number } | null = null;

  const valid = () => token !== null && now() < token.expiresAt;

  async function authorize(popup: Window): Promise<void> {
    const pkce = await createPkce();
    const state = randomState();
    const url = new URL(DROPBOX_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: config.appKey,
      response_type: 'code',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      redirect_uri: config.redirectUri,
      state,
      token_access_type: 'online',
      scope: DROPBOX_SCOPES.join(' '),
    }).toString();
    // Listen before navigating, so even an instant redirect is not missed.
    const redirect = waitForRedirect(state, popup, popupDeps);
    popup.location.href = url.toString();
    const code = await redirect;

    const response = await http.json(
      `${DROPBOX_API}/oauth2/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          grant_type: 'authorization_code',
          client_id: config.appKey,
          redirect_uri: config.redirectUri,
          code_verifier: pkce.verifier,
        }).toString(),
      },
      // An authorization code is single-use: never resend.
      { idempotent: false },
      tokenSchema,
    );
    const granted = new Set((response.scope ?? '').split(' '));
    if (!DROPBOX_SCOPES.every((s) => granted.has(s))) {
      throw new ProviderError('FORBIDDEN', 'Dropbox permissions not granted');
    }
    token = {
      value: response.access_token,
      expiresAt: now() + response.expires_in * 1000 - EXPIRY_MARGIN_MS,
    };
  }

  return {
    isSignedIn: valid,

    signIn() {
      // Opened synchronously from the click; navigated once PKCE is ready.
      const popup = popupDeps.open();
      if (!popup) return Promise.reject(new ProviderError('CANCELLED', 'Popup blocked'));
      return authorize(popup).catch((err: unknown) => {
        popup.close();
        if (err instanceof ProviderError) {
          // A rejected code exchange (400) is not a sign-in the user can fix by waiting.
          throw err.status === 400 ? new ProviderError('UNAVAILABLE', 'Code exchange failed') : err;
        }
        throw new ProviderError('UNAVAILABLE', 'Dropbox sign-in failed');
      });
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
