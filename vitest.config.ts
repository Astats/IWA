import { defineConfig } from 'vitest/config';

/** Date logic must not depend on the host time zone (TEST_PLAN §4.1). */
const tzProjects = ['Europe/Riga', 'America/New_York'].map((tz) => ({
  test: {
    name: `core-tz-${tz.split('/')[1]?.toLowerCase() ?? tz}`,
    root: './packages/core',
    environment: 'node' as const,
    include: ['src/dates.test.ts'],
    env: { TZ: tz },
  },
}));

export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'apps/*/vitest.config.ts',
      'tooling/vitest.config.ts',
      ...tzProjects,
    ],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    sequence: { shuffle: !!process.env.CI },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['packages/*/src/**', 'apps/web/src/**'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.browser.test.{ts,tsx}',
        '**/src/testing/**',
        '**/*.generated.ts',
        '**/*.d.ts',
        '**/index.ts',
        'apps/web/src/main.tsx',
        'apps/web/src/components/ui/**',
      ],
      // Floors per package (TEST_PLAN §3.2). Coverage is a floor, not a goal.
      thresholds: {
        'packages/core/src/**': { lines: 95, branches: 90 },
        'packages/core/src/csv/**': { lines: 95, branches: 90 },
        'packages/crypto/src/**': { lines: 95, branches: 90 },
        'packages/backup/src/**': { lines: 90, branches: 85 },
        'packages/db/src/**': { lines: 90, branches: 85 },
        'apps/web/src/**': { lines: 75, branches: 65 },
      },
    },
  },
});
