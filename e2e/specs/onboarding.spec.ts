import { expect, test, TEST_PASSPHRASE } from '../fixtures/app.fixture';

test.describe('J1 first run', () => {
  test('@smoke onboarding enforces the passphrase policy and opens the dashboard', async ({
    app,
    page,
  }) => {
    await app.onboarding.goto();
    await app.onboarding.start.click();

    // Policy feedback: too short, too common, mismatch, acknowledgement required.
    await app.onboarding.fillPassphraseStep('short');
    await app.onboarding.next.click();
    await expect(page.getByText('Use at least 12 characters.')).toBeVisible();
    await expect(app.onboarding.passphrase).toBeFocused();
    await app.onboarding.fillPassphraseStep('password1234');
    await app.onboarding.next.click();
    await expect(page.getByText('This passphrase is too common.', { exact: false })).toBeVisible();
    await app.onboarding.fillPassphraseStep(TEST_PASSPHRASE, `${TEST_PASSPHRASE}x`);
    await app.onboarding.next.click();
    await expect(page.getByText('The passphrases do not match.')).toBeVisible();
    await app.onboarding.fillPassphraseStep(TEST_PASSPHRASE);
    await expect(page.getByText(/Strength: (good|strong)/)).toBeVisible();
    await app.onboarding.next.click();
    await expect(page.getByText('Please confirm that you understand.')).toBeVisible();
    await expect(page.getByText(/your data cannot be recovered/)).toBeVisible();

    await app.onboarding.acknowledge.check();
    await app.onboarding.next.click();
    await app.onboarding.baseCurrency.selectOption('USD');
    await app.onboarding.create.click();

    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page).toHaveURL(/\/$/);
    await app.shell.navigate('Settings');
    await expect(app.settings.baseCurrency).toHaveValue('USD');
  });

  test('@security only the allow-listed UI prefs key is in Web Storage (SEC-W03)', async ({
    onboardedApp,
    page,
  }) => {
    await onboardedApp.shell.navigate('Settings');

    const storage = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    }));

    expect(storage.local.filter((k) => k !== 'budget.ui-prefs')).toEqual([]);
    expect(storage.session).toEqual([]);
  });
});
