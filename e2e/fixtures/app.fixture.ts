import { AppShell } from '../pages/AppShell';
import { generateCsv, ImportExportPage } from '../pages/ImportExportPage';
import { OnboardingPage } from '../pages/OnboardingPage';
import { SettingsPage } from '../pages/SettingsPage';
import { UnlockPage } from '../pages/UnlockPage';
import { expect, test as guarded } from './guard.fixture';
import { FakeGoogle } from './providers/google';
import { FakeMicrosoft } from './providers/microsoft';

/** Client ids the e2e build is made with (apps/web/.env.e2e). */
export const E2E_MS_CLIENT_ID = '00000000-0000-4000-8000-00000000e2e0';
export const E2E_GOOGLE_CLIENT_ID = 'e2e-google-client.apps.googleusercontent.com';

/** Mocked cloud providers (TEST_PLAN §3.3 fakeProviders); no real provider is ever contacted. */
export interface CloudFakes {
  microsoft: FakeMicrosoft;
  google: FakeGoogle;
}

/** Known test passphrase (only ever used against local test builds). */
export const TEST_PASSPHRASE = 'tulip river quiet lamp 2026';

export interface AppPages {
  onboarding: OnboardingPage;
  unlock: UnlockPage;
  shell: AppShell;
  settings: SettingsPage;
}

export const test = guarded.extend<{
  app: AppPages;
  onboardedApp: AppPages;
  /** Onboarded app seeded with  transactions imported through the real CSV import. */
  seededApp: AppPages;
  seedRows: number;
  cloud: CloudFakes;
}>({
  cloud: [
    async ({ context }, use) => {
      const fakes = { microsoft: new FakeMicrosoft(E2E_MS_CLIENT_ID), google: new FakeGoogle() };
      await fakes.microsoft.install(context);
      await fakes.google.install(context);
      await use(fakes);
    },
    { auto: true },
  ],
  seedRows: [1000, { option: true }],
  app: async ({ page }, use) => {
    await use({
      onboarding: new OnboardingPage(page),
      unlock: new UnlockPage(page),
      shell: new AppShell(page),
      settings: new SettingsPage(page),
    });
  },
  /** Completes onboarding through the UI with the known test passphrase (no backdoors). */
  onboardedApp: async ({ app }, use) => {
    await app.onboarding.goto();
    await app.onboarding.complete({ passphrase: TEST_PASSPHRASE });
    await use(app);
  },
  seededApp: async ({ onboardedApp, page, seedRows }, use) => {
    const importer = new ImportExportPage(page);
    await importer.goto();
    await importer.importFile('seed.csv', generateCsv(seedRows));
    await use(onboardedApp);
  },
});

export { expect };
