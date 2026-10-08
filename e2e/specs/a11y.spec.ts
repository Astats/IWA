import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect, test, TEST_PASSPHRASE } from '../fixtures/app.fixture';
import { BackupPage } from '../pages/BackupPage';

async function expectNoSeriousViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
  expect(serious, `axe violations on ${label}`).toEqual([]);
}

test.describe('@a11y accessibility (axe-core)', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`onboarding, unlock and app screens have no serious issues (${theme})`, async ({
      app,
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await app.onboarding.goto();
      await expectNoSeriousViolations(page, 'welcome');
      await app.onboarding.start.click();
      await expectNoSeriousViolations(page, 'passphrase step');
      await app.onboarding.next.click();
      await expectNoSeriousViolations(page, 'passphrase step with errors');
      await app.onboarding.fillPassphraseStep(TEST_PASSPHRASE);
      await app.onboarding.acknowledge.check();
      await app.onboarding.next.click();
      await expectNoSeriousViolations(page, 'preferences step');
      await app.onboarding.create.click();
      await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({
        timeout: 20_000,
      });
      await expectNoSeriousViolations(page, 'dashboard');
      await app.shell.navigate('Settings');
      await expectNoSeriousViolations(page, 'settings');
      const backup = new BackupPage(page);
      await backup.goto();
      await backup.connect('Test storage');
      await backup.backUpNow('Test storage', TEST_PASSPHRASE);
      await expectNoSeriousViolations(page, 'backup (cloud provider connected)');
      await app.shell.lock();
      await expectNoSeriousViolations(page, 'unlock');
      await app.unlock.unlock('wrong passphrase here');
      await expect(app.unlock.error).toBeVisible();
      await expectNoSeriousViolations(page, 'unlock with error');
    });
  }
});
