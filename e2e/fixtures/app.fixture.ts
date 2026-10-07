import { AppShell } from '../pages/AppShell';
import { OnboardingPage } from '../pages/OnboardingPage';
import { SettingsPage } from '../pages/SettingsPage';
import { UnlockPage } from '../pages/UnlockPage';
import { expect, test as guarded } from './guard.fixture';

/** Known test passphrase (only ever used against local test builds). */
export const TEST_PASSPHRASE = 'tulip river quiet lamp 2026';

export interface AppPages {
  onboarding: OnboardingPage;
  unlock: UnlockPage;
  shell: AppShell;
  settings: SettingsPage;
}

export const test = guarded.extend<{ app: AppPages; onboardedApp: AppPages }>({
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
});

export { expect };
