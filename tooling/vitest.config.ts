import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'tooling',
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['lint-fixtures/**'],
    testTimeout: 30_000,
  },
});
