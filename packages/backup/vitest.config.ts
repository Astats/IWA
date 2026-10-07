import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'backup',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
