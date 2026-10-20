import { DROPBOX_API, DROPBOX_SCOPES, GDRIVE_SCOPES, ONEDRIVE_SCOPES } from '@budget/backup';

import { APP_URL_SCHEME, type AuthBrowser, type PlatformService } from '@/platform';

import { DROPBOX_AUTHORIZE_URL } from './dropbox-session';
import type { NativeOAuthConfig } from './native-oauth';

/*
 * Native OAuth clients (BUILD_PLAN 4.3). Each needs a redirect URI registered with the provider
 * (🧑 HUMAN, see docs/mobile-release.md):
 * - Microsoft: the same Entra app, platform "Mobile and desktop applications".
 * - Google: separate Android and iOS OAuth clients (Android: "custom URI scheme" enabled).
 * - Dropbox: the same app key with the custom-scheme redirect URI added.
 */

export const MICROSOFT_NATIVE_REDIRECT = `${APP_URL_SCHEME}://auth/callback/microsoft`;
export const DROPBOX_NATIVE_REDIRECT = `${APP_URL_SCHEME}://auth/callback/dropbox`;
/** Google Android clients redirect on the package name as scheme. */
export const GOOGLE_ANDROID_REDIRECT = `${APP_URL_SCHEME}:/oauth2redirect`;

/** Google iOS clients redirect on the reversed client id (it must be in Info.plist URL types). */
export function googleIosRedirect(clientId: string): string {
  const id = clientId.replace(/\.apps\.googleusercontent\.com$/, '');
  return `com.googleusercontent.apps.${id}:/oauth2redirect`;
}

export interface NativeClientIds {
  microsoft?: string | undefined;
  googleAndroid?: string | undefined;
  googleIos?: string | undefined;
  dropbox?: string | undefined;
}

export type NativeProviderId = 'onedrive' | 'gdrive' | 'dropbox';

/** OAuth configurations for the providers whose native client ids are configured. */
export function nativeOAuthConfigs(
  platform: Pick<PlatformService, 'id'>,
  ids: NativeClientIds,
): Partial<Record<NativeProviderId, NativeOAuthConfig>> {
  const configs: Partial<Record<NativeProviderId, NativeOAuthConfig>> = {};
  if (ids.microsoft) {
    configs.onedrive = {
      authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      clientId: ids.microsoft,
      redirectUri: MICROSOFT_NATIVE_REDIRECT,
      scopes: ONEDRIVE_SCOPES,
      extraParams: { prompt: 'select_account' },
      // Entra may report Graph scopes with their resource prefix.
      normalizeScope: (s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, ''),
    };
  }
  const googleId = platform.id === 'ios' ? ids.googleIos : ids.googleAndroid;
  if (googleId) {
    configs.gdrive = {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: googleId,
      redirectUri: platform.id === 'ios' ? googleIosRedirect(googleId) : GOOGLE_ANDROID_REDIRECT,
      scopes: GDRIVE_SCOPES,
    };
  }
  if (ids.dropbox) {
    configs.dropbox = {
      authorizeUrl: DROPBOX_AUTHORIZE_URL,
      tokenUrl: `${DROPBOX_API}/oauth2/token`,
      clientId: ids.dropbox,
      redirectUri: DROPBOX_NATIVE_REDIRECT,
      scopes: DROPBOX_SCOPES,
      // Short-lived access token only (no refresh token), as on the web.
      extraParams: { token_access_type: 'online' },
    };
  }
  return configs;
}

/** True when the platform can run native sign-in. */
export function hasAuthBrowser(
  platform: PlatformService,
): platform is PlatformService & { authBrowser: AuthBrowser } {
  return platform.authBrowser !== undefined;
}
