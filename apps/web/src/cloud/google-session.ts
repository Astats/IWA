import { GDRIVE_SCOPES, ProviderError, type OAuthSession } from '@budget/backup';

/*
 * Google Drive sign-in with the Google Identity Services (GIS) token client (BUILD_PLAN 3.3).
 * GIS hands a short-lived access token to this page; there is no client secret and no refresh
 * token. The token lives in memory only; when it expires the user connects again.
 */

export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
}

interface TokenClient {
  requestAccessToken(): void;
}

export interface GoogleOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: { type?: string }) => void;
  }): TokenClient;
  hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean;
}

declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth2 } };
  }
}

let gisPromise: Promise<GoogleOAuth2> | null = null;

/** Loads the GIS library once (only when the Backup screen shows Google Drive). */
export function loadGis(doc: Document = document): Promise<GoogleOAuth2> {
  gisPromise ??= new Promise<GoogleOAuth2>((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    script.addEventListener('load', () => {
      const oauth2 = window.google?.accounts?.oauth2;
      if (oauth2) resolve(oauth2);
      else reject(new Error('GIS did not initialize'));
    });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error('GIS failed to load'));
    });
    doc.head.append(script);
  }).catch((err: unknown) => {
    gisPromise = null; // allow a retry (e.g. after going back online)
    throw err;
  });
  return gisPromise;
}

/** Test seam: forget the cached library promise. */
export function resetGisForTests(): void {
  gisPromise = null;
}

export interface GoogleSessionConfig {
  clientId: string;
  load?: () => Promise<GoogleOAuth2>;
  now?: () => number;
}

/** Tokens are treated as expired a minute early, so a request never starts with a dying token. */
const EXPIRY_MARGIN_MS = 60_000;

export function createGoogleSession(config: GoogleSessionConfig): OAuthSession {
  const load = config.load ?? (() => loadGis());
  const now = config.now ?? (() => Date.now());
  const scope = GDRIVE_SCOPES.join(' ');
  let gis: GoogleOAuth2 | null = null;
  let token: { value: string; expiresAt: number } | null = null;

  const valid = () => token !== null && now() < token.expiresAt;

  const request = (oauth2: GoogleOAuth2) =>
    new Promise<void>((resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: config.clientId,
        scope,
        callback: (response) => {
          if (response.error || !response.access_token) {
            reject(new ProviderError('CANCELLED'));
            return;
          }
          // With granular consent the user may untick the Drive permission.
          if (!oauth2.hasGrantedAllScopes(response, ...GDRIVE_SCOPES)) {
            reject(new ProviderError('FORBIDDEN', 'Drive permission not granted'));
            return;
          }
          const seconds = Number(response.expires_in);
          const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
          token = { value: response.access_token, expiresAt: now() + lifetime - EXPIRY_MARGIN_MS };
          resolve();
        },
        error_callback: (error) => {
          reject(
            new ProviderError(
              error.type === 'popup_closed' || error.type === 'popup_failed_to_open'
                ? 'CANCELLED'
                : 'UNAVAILABLE',
            ),
          );
        },
      });
      // Synchronous from the click when the library is preloaded, so the popup is not blocked.
      client.requestAccessToken();
    });

  return {
    isSignedIn: valid,

    async prepare() {
      gis ??= await load();
    },

    signIn() {
      if (gis) return request(gis);
      return load().then(
        (oauth2) => {
          gis = oauth2;
          return request(oauth2);
        },
        () => {
          throw new ProviderError('UNAVAILABLE', 'Could not load Google sign-in');
        },
      );
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
