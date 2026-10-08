import type { Page } from '@playwright/test';

import { expect, test, TEST_PASSPHRASE } from '../fixtures/app.fixture';
import { BackupPage } from '../pages/BackupPage';
import { TransactionsPage } from '../pages/TransactionsPage';

const FAKE = 'Test storage';

/** Revokes the session of the e2e-only fake provider (present in `--mode e2e` builds only). */
function revokeFakeSession(page: Page) {
  return page.evaluate(() => {
    (
      window as unknown as { __E2E_HOOKS__: { fakeProvider: { revoke(): void } } }
    ).__E2E_HOOKS__.fakeProvider.revoke();
  });
}

test.describe('J13 cloud backup (fake provider)', () => {
  test('@smoke connect → back up → list → restore → delete → disconnect', async ({
    onboardedApp: app,
    page,
  }) => {
    test.setTimeout(90_000);
    const tx = new TransactionsPage(page);
    const backup = new BackupPage(page);
    await tx.goto();
    await tx.addExpense({ amount: '12.50', category: 'Food', date: '2026-03-02', note: 'Lunch' });

    await backup.goto();
    await backup.connect(FAKE);
    await expect(backup.provider(FAKE).getByText('No backups yet.')).toBeVisible();
    await backup.backUpNow(FAKE, TEST_PASSPHRASE);
    await expect(backup.remoteItems(FAKE)).toHaveCount(1);
    await expect(backup.provider(FAKE).getByText(/^Last backup: /)).toBeVisible();

    // Change the data, back up again (two backups now), then restore the older one.
    await tx.goto();
    await tx.addExpense({ amount: '99', category: 'Food', date: '2026-03-03', note: 'Dinner' });
    await backup.goto();
    await backup.backUpNow(FAKE, TEST_PASSPHRASE);
    await expect(backup.remoteItems(FAKE)).toHaveCount(2);
    await backup.restoreRemote(FAKE, 1, TEST_PASSPHRASE, 'Replace');
    await tx.goto();
    expect(await tx.notes()).toEqual(['Lunch']);

    await backup.goto();
    await backup.deleteRemote(FAKE, 0);
    await expect(backup.remoteItems(FAKE)).toHaveCount(1);
    await backup.disconnect(FAKE);
    await expect(page.getByRole('button', { name: `Connect ${FAKE}` })).toBeVisible();

    // Locking drops the provider session: after unlocking it shows as not connected.
    await backup.connect(FAKE);
    await app.shell.lock();
    await app.unlock.unlock(TEST_PASSPHRASE);
    await backup.goto();
    await expect(backup.provider(FAKE).getByText('Not connected')).toBeVisible();
  });

  test('a revoked session asks the user to connect again', async ({ onboardedApp: _app, page }) => {
    const backup = new BackupPage(page);
    await backup.goto();
    await backup.connect(FAKE);
    const section = backup.provider(FAKE);
    await expect(section.getByText('No backups yet.')).toBeVisible();
    await revokeFakeSession(page);

    await section.getByLabel('Current passphrase').fill(TEST_PASSPHRASE);
    await section.getByRole('button', { name: 'Back up now' }).click();

    await expect(section.getByRole('alert')).toHaveText(
      'Your sign-in has expired or was revoked. Connect again.',
    );
    await expect(section.getByText('Not connected')).toBeVisible();
  });
});
