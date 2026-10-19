/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  /** Microsoft Entra application (client) ID for OneDrive backups. Public, not a secret. */
  readonly VITE_MS_CLIENT_ID?: string;
  /** Google OAuth client ID (type "Web application") for Google Drive backups. Public. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** Dropbox app key (App folder access, PKCE; no secret) for Dropbox backups. Public. */
  readonly VITE_DROPBOX_APP_KEY?: string;
}

/** App version from package.json, injected at build time. */
declare const __APP_VERSION__: string;
