import type { Page } from '@playwright/test';

import { expect, test, TEST_PASSPHRASE, type AppPages } from '../fixtures/app.fixture';
import { FakeMicrosoft, MS_ACCESS_TOKEN } from '../fixtures/providers/microsoft';
import { BackupPage } from '../pages/BackupPage';
import { TransactionsPage } from '../pages/TransactionsPage';

const FAKE = 'Test storage';
const ONEDRIVE = 'Microsoft OneDrive';
/** Client id the e2e build is made with (apps/web/.env.e2e). */
const E2E_MS_CLIENT_ID = '00000000-0000-4000-8000-00000000e2e0';

/** Revokes the session of the e2e-only fake provider (present in `--mode e2e` builds only). */
function revokeFakeSession(page: Page) {
  return page.evaluate(() => {
    (
      window as unknown as { __E2E_HOOKS__: { fakeProvider: { revoke(): void } } }
    ).__E2E_HOOKS__.fakeProvider.revoke();
  });
}

/** J13: connect → back up → list → restore → delete → disconnect → session dropped on lock. */
async function cloudJourney(page: Page, app: AppPages, provider: string) {
  const tx = new TransactionsPage(page);
  const backup = new BackupPage(page);
  await tx.goto();
  await tx.addExpense({ amount: '12.50', category: 'Food', date: '2026-03-02', note: 'Lunch' });

  await backup.goto();
  await backup.connect(provider);
  await expect(backup.provider(provider).getByText('No backups yet.')).toBeVisible();
  await backup.backUpNow(provider, TEST_PASSPHRASE);
  await expect(backup.remoteItems(provider)).toHaveCount(1);
  await expect(backup.provider(provider).getByText(/^Last backup: /)).toBeVisible();

  // Change the data, back up again (two backups now), then restore the older one.
  await tx.goto();
  await tx.addExpense({ amount: '99', category: 'Food', date: '2026-03-03', note: 'Dinner' });
  await backup.goto();
  await backup.backUpNow(provider, TEST_PASSPHRASE);
  await expect(backup.remoteItems(provider)).toHaveCount(2);
  await backup.restoreRemote(provider, 1, TEST_PASSPHRASE, 'Replace');
  await tx.goto();
  expect(await tx.notes()).toEqual(['Lunch']);

  await backup.goto();
  await backup.deleteRemote(provider, 0);
  await expect(backup.remoteItems(provider)).toHaveCount(1);
  await backup.disconnect(provider);

  // Locking drops the provider session: after unlocking it shows as not connected.
  await backup.connect(provider);
  await app.shell.lock();
  await app.unlock.unlock(TEST_PASSPHRASE);
  await backup.goto();
  await expect(backup.provider(provider).getByText('Not connected')).toBeVisible();
}

test.describe('J13 cloud backup (fake provider)', () => {
  test('@smoke connect → back up → list → restore → delete → disconnect', async ({
    onboardedApp: app,
    page,
  }) => {
    test.setTimeout(90_000);
    await cloudJourney(page, app, FAKE);
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

test.describe('J13 cloud backup (Microsoft OneDrive, mocked)', () => {
  test('full journey through the real MSAL popup flow', async ({
    onboardedApp: app,
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    const microsoft = new FakeMicrosoft(E2E_MS_CLIENT_ID);
    await microsoft.install(context);

    await cloudJourney(page, app, ONEDRIVE);

    // Only ciphertext reached the provider.
    const [stored] = [...microsoft.files.values()];
    expect(stored?.bytes.subarray(0, 4).toString()).toBe('BGTB');
    expect(stored?.bytes.includes(Buffer.from('Lunch'))).toBe(false);
  });

  test('@security SEC-W13 PKCE S256, state, minimal scope; tokens in memory only', async ({
    onboardedApp: _app,
    page,
    context,
  }) => {
    const microsoft = new FakeMicrosoft(E2E_MS_CLIENT_ID);
    await microsoft.install(context);
    const backup = new BackupPage(page);
    await backup.goto();

    await backup.connect(ONEDRIVE);
    await expect(backup.provider(ONEDRIVE).getByText('No backups yet.')).toBeVisible();

    const [authorize] = microsoft.authorizeUrls;
    expect(authorize?.searchParams.get('response_type')).toBe('code');
    expect(authorize?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize?.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(authorize?.searchParams.get('state')).toBeTruthy();
    expect(authorize?.searchParams.get('client_id')).toBe(E2E_MS_CLIENT_ID);
    // The only API permission is the app folder; the rest are the OpenID sign-in scopes.
    const scopes = (authorize?.searchParams.get('scope') ?? '').split(' ').sort();
    expect(scopes.filter((s) => !['openid', 'profile', 'offline_access'].includes(s))).toEqual([
      'Files.ReadWrite.AppFolder',
    ]);
    expect(authorize?.searchParams.get('redirect_uri')).toBe(
      `${new URL(page.url()).origin}/auth/callback/microsoft`,
    );

    // Tokens are never written to Web Storage or IndexedDB (BUILD_PLAN §6.1).
    const storage = await page.evaluate(async () => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
      databases: (await indexedDB.databases()).map((d) => d.name ?? ''),
    }));
    expect(storage.local.map(([key]) => key)).toEqual(['budget.ui-prefs']);
    expect(JSON.stringify([...storage.local, ...storage.session])).not.toContain(MS_ACCESS_TOKEN);
    expect(storage.databases.filter((name) => /msal/i.test(name))).toEqual([]);
    // Graph only ever received the issued token.
    expect(microsoft.graphRequests.every((r) => r.authorized)).toBe(true);
  });

  test('access revoked at Microsoft → reconnect prompt', async ({
    onboardedApp: _app,
    page,
    context,
    guard,
  }) => {
    // Chrome logs every failed response; the 401 is the point of this test.
    guard.expectConsoleError(/status of 401/);
    const microsoft = new FakeMicrosoft(E2E_MS_CLIENT_ID);
    await microsoft.install(context);
    const backup = new BackupPage(page);
    await backup.goto();
    await backup.connect(ONEDRIVE);
    const section = backup.provider(ONEDRIVE);
    await expect(section.getByText('No backups yet.')).toBeVisible();
    microsoft.revoke();

    await section.getByLabel('Current passphrase').fill(TEST_PASSPHRASE);
    await section.getByRole('button', { name: 'Back up now' }).click();

    await expect(section.getByRole('alert')).toHaveText(
      'Your sign-in has expired or was revoked. Connect again.',
    );
    await expect(section.getByText('Not connected')).toBeVisible();
  });
});
