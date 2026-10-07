import { expect, test, TEST_PASSPHRASE } from '../fixtures/app.fixture';

test.describe('lock and unlock', () => {
  test('@smoke @security J7 manual lock, wrong passphrase with progressive delay, then unlock', async ({
    onboardedApp: app,
    page,
  }) => {
    await app.shell.navigate('Settings');
    await app.settings.baseCurrency.selectOption('GBP');
    await app.settings.saveSettings();

    await app.shell.lock();
    await expect(page.getByLabel('Base currency')).toHaveCount(0);
    await app.unlock.unlock('definitely the wrong passphrase');

    await expect(app.unlock.error).toHaveText(
      'Unlock failed. Check your passphrase and try again.',
    );
    await expect(page.getByText(/Too many attempts\. Try again in \d+ s\./)).toBeVisible();
    await expect(app.unlock.submit).toBeDisabled();

    await app.unlock.passphrase.fill(TEST_PASSPHRASE);
    await expect(app.unlock.submit).toBeEnabled({ timeout: 5_000 });
    await app.unlock.submit.click();
    // Unlock returns to the page the user was on.
    await app.settings.expectLoaded();
    await expect(app.settings.baseCurrency).toHaveValue('GBP');
  });

  test('@smoke J9 data persists across a reload', async ({ onboardedApp: app, page }) => {
    await app.shell.navigate('Settings');
    await app.settings.autoLock.fill('15');
    await app.settings.theme.selectOption('dark');
    await app.settings.saveSettings();

    await page.reload();
    await app.unlock.expectLoaded();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await app.unlock.unlock(TEST_PASSPHRASE);

    await app.shell.navigate('Settings');
    await expect(app.settings.autoLock).toHaveValue('15');
    await expect(app.settings.theme).toHaveValue('dark');
  });

  test('@smoke @security J8 auto-lock after inactivity removes data from the DOM', async ({
    app,
    page,
  }) => {
    await page.clock.install();
    await app.onboarding.goto();
    await app.onboarding.complete({ passphrase: TEST_PASSPHRASE, currency: 'CHF' });
    await app.shell.navigate('Settings');
    await expect(app.settings.baseCurrency).toHaveValue('CHF');

    await page.clock.fastForward('04:00');
    await expect(app.settings.baseCurrency).toBeVisible();
    await page.clock.fastForward('01:01');

    await app.unlock.expectLoaded();
    await expect(page.getByLabel('Base currency')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Swiss Franc');
  });

  test('@security J14 change passphrase: old fails, new works', async ({
    onboardedApp: app,
    page,
  }) => {
    const next = 'brand new passphrase for budget';
    await app.shell.navigate('Settings');

    await app.settings.changePassphrase('wrong current passphrase', next);
    await expect(page.getByRole('alert')).toHaveText(/could not be changed/);
    await app.settings.changePassphrase(TEST_PASSPHRASE, next);
    await expect(page.getByText('Passphrase changed.')).toBeVisible({ timeout: 20_000 });

    await app.shell.lock();
    await app.unlock.unlock(TEST_PASSPHRASE);
    await expect(app.unlock.error).toBeVisible();
    await app.unlock.passphrase.fill(next);
    await expect(app.unlock.submit).toBeEnabled({ timeout: 5_000 });
    await app.unlock.submit.click();
    await app.settings.expectLoaded();
  });
});
