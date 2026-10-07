import path from 'node:path';

import { playwright } from '@vitest/browser-playwright';
import { defineProject } from 'vitest/config';

// Browser-mode integration tests (TEST_PLAN L3b): storage worker, OPFS, IndexedDB fallback.
export default defineProject({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  optimizeDeps: {
    include: [
      'hash-wasm',
      'comlink',
      'zod',
      'uuid',
      'dinero.js/bigint',
      'drizzle-orm',
      'drizzle-orm/sqlite-proxy',
      'drizzle-orm/sqlite-core',
    ],
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  worker: { format: 'es' },
  test: {
    name: 'web-browser',
    include: ['src/**/*.browser.test.ts'],
    testTimeout: 30_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
