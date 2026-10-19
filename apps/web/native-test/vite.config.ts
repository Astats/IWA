import path from 'node:path';

import { defineConfig } from 'vite';

/** Builds the instrumented contract run (native-test/) into dist-native-test/. Test-only. */
export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '../src'),
      // The contract suite imports vitest; on the device a small compatible runner stands in.
      vitest: path.resolve(import.meta.dirname, 'vitest-shim.ts'),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, '../dist-native-test'),
    emptyOutDir: true,
    target: 'es2023',
  },
});
