// Content Security Policy for the web app (BUILD_PLAN §6.2). Shared by vite.config.ts and
// scripts/verify-build.mjs. `frame-ancestors` is omitted on purpose: browsers ignore it in a
// <meta> CSP (and log an error); Caddy sets it as an HTTP header in Phase 5 (SEC-W15).
// Provider origins are added to connect-src only in the step that needs them (see SECURITY.md).

/** @type {Record<string, string[]>} */
export const cspDirectives = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'worker-src': ["'self'"],
  'connect-src': ["'self'"],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'upgrade-insecure-requests': [],
};

export const cspPolicy = Object.entries(cspDirectives)
  .map(([name, values]) => [name, ...values].join(' '))
  .join('; ');
