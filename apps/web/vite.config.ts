import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { cspPolicy } from './csp.mjs';

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

export default defineConfig({
  plugins: [react(), tailwindcss(), cspMeta()],
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
  },
  worker: { format: 'es' },
});
