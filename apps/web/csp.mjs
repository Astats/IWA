// Content Security Policy for the web app (BUILD_PLAN §6.2). Shared by vite.config.ts and
// scripts/verify-build.mjs. `frame-ancestors` is omitted on purpose: browsers ignore it in a
// <meta> CSP (and log an error); Caddy sets it as an HTTP header in Phase 5 (SEC-W15).
// Provider origins are added to connect-src only in the step that needs them (see SECURITY.md).

/** @type {Record<string, string[]>} */
export const cspDirectives = {
  'default-src': ["'self'"],
  // Google Identity Services (Step 3.3) is the only third-party script; loaded on the Backup screen.
  'script-src': ["'self'", "'wasm-unsafe-eval'", 'https://accounts.google.com/gsi/client'],
  'style-src': ["'self'", 'https://accounts.google.com/gsi/style'],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'worker-src': ["'self'"],
  // Cloud backup providers (SECURITY.md lists the reason for each origin).
  'connect-src': [
    "'self'",
    // Microsoft OneDrive (Step 3.2): sign-in token endpoint, Graph API, upload/download hosts.
    'https://login.microsoftonline.com',
    'https://graph.microsoft.com',
    'https://*.1drv.com',
    'https://*.sharepoint.com',
    // Google Drive (Step 3.3): GIS endpoints and the Drive API (incl. uploads).
    'https://accounts.google.com/gsi/',
    'https://www.googleapis.com',
    // Dropbox (Step 3.4): OAuth token endpoint + RPC API, and the content (upload/download) API.
    'https://api.dropboxapi.com',
    'https://content.dropboxapi.com',
  ],
  // GIS may use iframes on its own origin (Google's documented CSP for the library).
  'frame-src': ['https://accounts.google.com/gsi/'],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'upgrade-insecure-requests': [],
};

export const cspPolicy = Object.entries(cspDirectives)
  .map(([name, values]) => [name, ...values].join(' '))
  .join('; ');
