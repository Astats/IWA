import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { cspPolicy } from './csp.mjs';
import pkg from './package.json' with { type: 'json' };

/** Injects the CSP meta tag into production builds only (dev needs inline HMR scripts/styles). */
function cspMeta(): Plugin {
  return {
    name: 'budget:csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: cspPolicy },
          injectTo: 'head-prepend',
        },
      ],
    },
  };
}

/** OAuth popup redirect URIs (registered with the providers) → their bridge pages. */
const AUTH_CALLBACKS: Record<string, string> = {
  '/auth/callback/microsoft': '/auth/callback/microsoft/index.html',
  '/auth/callback/dropbox': '/auth/callback/dropbox/index.html',
};

/**
 * Serves the OAuth redirect bridge pages at their exact registered URIs (no trailing slash) in
 * dev and preview; otherwise the SPA fallback would answer with the app shell.
 */
function authCallbackRoutes(): Plugin {
  const rewrite = (req: IncomingMessage, _res: ServerResponse, next: () => void) => {
    const [pathname = '', query] = (req.url ?? '').split('?');
    const target = AUTH_CALLBACKS[pathname];
    if (target) req.url = query === undefined ? target : `${target}?${query}`;
    next();
  };
  return {
    name: 'budget:auth-callback-routes',
    configureServer: (server) => {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(rewrite);
    },
  };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    tailwindcss(),
    cspMeta(),
    authCallbackRoutes(),
    VitePWA({
      // The app asks before activating a new version ("New version available — reload").
      registerType: 'prompt',
      // Registration happens in src/app/UpdatePrompt.tsx (bundled, CSP-safe; no inline script).
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Budget',
        short_name: 'Budget',
        description: 'Private, encrypted budget tracking that works offline.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#0f766e',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell only (BUILD_PLAN 1.10): no runtime caching of any responses.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,woff2,webmanifest}'],
        // sqlite-wasm ships workers this app never uses (we run our own worker).
        globIgnores: ['**/sqlite3-worker1-*.js', '**/sqlite3-opfs-async-proxy-*.js'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: 'index.html',
        // OAuth redirect pages are real files, never the SPA shell.
        navigateFallbackDenylist: [/^\/auth\//],
        cleanupOutdatedCaches: true,
        sourcemap: false,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  // sqlite-wasm resolves its .wasm file relative to its own module; pre-bundling would break that.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    target: 'es2023',
    sourcemap: false,
    rolldownOptions: {
      input: {
        index: path.resolve(import.meta.dirname, 'index.html'),
        // OAuth popup redirect bridge (BUILD_PLAN 3.2).
        microsoftCallback: path.resolve(import.meta.dirname, 'auth/callback/microsoft/index.html'),
        dropboxCallback: path.resolve(import.meta.dirname, 'auth/callback/dropbox/index.html'),
      },
    },
  },
  worker: { format: 'es' },
});
