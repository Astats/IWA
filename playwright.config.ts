import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './e2e/specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // More than 2 parallel headless browsers made localhost requests stall on the Windows dev
  // machine (reproduced with plain fetch() from a static page, no app code involved).
  workers: 2,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['junit', { outputFile: 'test-results/junit.xml' }], ['github']]
    : [['list'], ['html', { open: 'never' }]],
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 15'] } },
  ],
  // Tests run against a production build (including the CSP), never the dev server. It is built in
  // the `e2e` mode, which only adds the fake cloud provider (src/app/e2e-hooks.ts) and fake OAuth
  // client ids (.env.e2e); `pnpm build` proves none of that reaches the real dist/ (SEC-W14).
  webServer: {
    command: `pnpm --filter web build:e2e && pnpm --filter web preview:e2e --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
