import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify('0.0.0-test') },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    name: 'web-unit',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['src/**/*.browser.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
