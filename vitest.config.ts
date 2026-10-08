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
      'apps/*/vitest.browser.config.ts',
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
      // Coverage runs all projects (incl. browser mode): Vitest collects nothing when --project filters are used.
      include: ['packages/*/src/**', 'apps/web/src/**'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.browser.test.{ts,tsx}',
        '**/src/testing/**',
        '**/*.generated.ts',
        '**/*.d.ts',
        '**/index.ts',
        'apps/web/src/main.tsx',
        // Production wiring of the real worker; exercised by the e2e suite.
        'apps/web/src/app/browser-services.ts',
        'apps/web/src/test/**',
        'apps/web/src/storage/storage-scan.ts',
        // Runs inside a Web Worker, which browser-mode v8 coverage does not instrument; its behaviour
        // is covered by src/storage/db.worker.browser.test.ts.
        'apps/web/src/storage/db.worker.ts',
        // CSV import worker + its comlink wrapper: worker realm; covered by e2e/specs/csv-import.spec.ts
        // (the same parse/validate pipeline is unit-tested in packages/core/src/csv).
        'apps/web/src/features/import-export/csv.worker.ts',
        'apps/web/src/features/import-export/csv-parser.ts',
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
