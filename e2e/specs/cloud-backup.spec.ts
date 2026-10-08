import type { Page } from '@playwright/test';

import {
  E2E_DROPBOX_APP_KEY,
  E2E_GOOGLE_CLIENT_ID,
  E2E_MS_CLIENT_ID,
  expect,
  test,
  TEST_PASSPHRASE,
  type AppPages,
} from '../fixtures/app.fixture';
import { DROPBOX_ACCESS_TOKEN } from '../fixtures/providers/dropbox';
import { GOOGLE_ACCESS_TOKEN } from '../fixtures/providers/google';
import { MS_ACCESS_TOKEN } from '../fixtures/providers/microsoft';
import { BackupPage } from '../pages/BackupPage';
import { TransactionsPage } from '../pages/TransactionsPage';

const FAKE = 'Test storage';
const ONEDRIVE = 'Microsoft OneDrive';
const GDRIVE = 'Google Drive';
const DROPBOX = 'Dropbox';

/** Web Storage and IndexedDB must never hold provider tokens (BUILD_PLAN §6.1). */
async function expectNoTokensStored(page: Page, token: string) {
  const storage = await page.evaluate(async () => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    databases: (await indexedDB.databases()).map((d) => d.name ?? ''),
  }));
  expect(storage.local.map(([key]) => key)).toEqual(['budget.ui-prefs']);
  expect(JSON.stringify([...storage.local, ...storage.session])).not.toContain(token);
  expect(storage.databases.filter((name) => /msal|google|gsi/i.test(name))).toEqual([]);
}

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

  // Change the data, back up again (two backups now), then restore the older one. Backup names
  // have one-second resolution, so make sure the second backup gets a different name.
  await page.waitForTimeout(1_100);
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
    cloud: { microsoft },
  }) => {
    test.setTimeout(90_000);
    await cloudJourney(page, app, ONEDRIVE);

    // Only ciphertext reached the provider.
    const [stored] = [...microsoft.files.values()];
    expect(stored?.bytes.subarray(0, 4).toString()).toBe('BGTB');
    expect(stored?.bytes.includes(Buffer.from('Lunch'))).toBe(false);
  });

  test('@security SEC-W13 PKCE S256, state, minimal scope; tokens in memory only', async ({
    onboardedApp: _app,
    page,
    cloud: { microsoft },
  }) => {
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

    await expectNoTokensStored(page, MS_ACCESS_TOKEN);
    // Graph only ever received the issued token.
    expect(microsoft.graphRequests.every((r) => r.authorized)).toBe(true);
  });

  test('access revoked at Microsoft → reconnect prompt', async ({
    onboardedApp: _app,
    page,
    guard,
    cloud: { microsoft },
  }) => {
    // Chrome logs every failed response; the 401 is the point of this test.
    guard.expectConsoleError(/status of 401/);
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

test.describe('J13 cloud backup (Google Drive, mocked)', () => {
  test('full journey through the GIS token client', async ({
    onboardedApp: app,
    page,
    cloud: { google },
  }) => {
    test.setTimeout(90_000);
    await cloudJourney(page, app, GDRIVE);

    const [stored] = [...google.files.values()];
    expect(stored?.bytes.subarray(0, 4).toString()).toBe('BGTB');
    expect(stored?.bytes.includes(Buffer.from('Lunch'))).toBe(false);
  });

  test('@security SEC-W13 only drive.appdata is requested; token in memory only', async ({
    onboardedApp: _app,
    page,
    cloud: { google },
  }) => {
    const backup = new BackupPage(page);
    await backup.goto();
    await backup.connect(GDRIVE);
    await expect(backup.provider(GDRIVE).getByText('No backups yet.')).toBeVisible();

    const configs = await page.evaluate(
      () => (window as unknown as { __fakeGis: { configs: unknown[] } }).__fakeGis.configs,
    );
    expect(configs).toEqual([
      { client_id: E2E_GOOGLE_CLIENT_ID, scope: 'https://www.googleapis.com/auth/drive.appdata' },
    ]);
    await expectNoTokensStored(page, GOOGLE_ACCESS_TOKEN);
    expect(google.apiRequests.every((r) => r.authorized)).toBe(true);
    // Drive calls stay inside the hidden app folder.
    expect(
      google.apiRequests
        .filter((r) => r.method === 'GET' && new URL(r.url).pathname === '/drive/v3/files')
        .every((r) => new URL(r.url).searchParams.get('spaces') === 'appDataFolder'),
    ).toBe(true);
  });

  test('denied consent stays disconnected', async ({ onboardedApp: _app, page }) => {
    const backup = new BackupPage(page);
    await backup.goto();
    await expect(backup.provider(GDRIVE).getByText('Not connected')).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __fakeGis: { deny: boolean } }).__fakeGis.deny = true;
    });

    await page.getByRole('button', { name: 'Connect ' + GDRIVE }).click();

    await expect(backup.provider(GDRIVE).getByRole('alert')).toHaveText('Sign-in was cancelled.');
    await expect(backup.provider(GDRIVE).getByText('Not connected')).toBeVisible();
  });

  test('access revoked at Google → reconnect prompt', async ({
    onboardedApp: _app,
    page,
    guard,
    cloud: { google },
  }) => {
    guard.expectConsoleError(/status of 401/);
    const backup = new BackupPage(page);
    await backup.goto();
    await backup.connect(GDRIVE);
    const section = backup.provider(GDRIVE);
    await expect(section.getByText('No backups yet.')).toBeVisible();
    google.revoke();

    await section.getByLabel('Current passphrase').fill(TEST_PASSPHRASE);
    await section.getByRole('button', { name: 'Back up now' }).click();

    await expect(section.getByRole('alert')).toHaveText(
      'Your sign-in has expired or was revoked. Connect again.',
    );
    await expect(section.getByText('Not connected')).toBeVisible();
  });
});

test.describe('J13 cloud backup (Dropbox, mocked)', () => {
  test('full journey through the PKCE popup flow', async ({
    onboardedApp: app,
    page,
    cloud: { dropbox },
  }) => {
    test.setTimeout(90_000);
    await cloudJourney(page, app, DROPBOX);

    const [stored] = [...dropbox.files.values()];
    expect(stored?.bytes.subarray(0, 4).toString()).toBe('BGTB');
    expect(stored?.bytes.includes(Buffer.from('Lunch'))).toBe(false);
  });

  test('@security SEC-W13 PKCE S256, state, minimal scopes; token in memory only', async ({
    onboardedApp: _app,
    page,
    cloud: { dropbox },
  }) => {
    const backup = new BackupPage(page);
    await backup.goto();
    await backup.connect(DROPBOX);
    await expect(backup.provider(DROPBOX).getByText('No backups yet.')).toBeVisible();

    const [authorize] = dropbox.authorizeUrls;
    const q = authorize?.searchParams;
    expect(q?.get('client_id')).toBe(E2E_DROPBOX_APP_KEY);
    expect(q?.get('response_type')).toBe('code');
    expect(q?.get('code_challenge_method')).toBe('S256');
    expect(q?.get('token_access_type')).toBe('online');
    expect(q?.get('scope')).toBe('files.metadata.read files.content.read files.content.write');
    expect(q?.get('redirect_uri')).toBe(`${new URL(page.url()).origin}/auth/callback/dropbox`);
    // The fake token endpoint only answers when the verifier matches the challenge.
    expect(dropbox.tokenRequests[0]?.has('client_secret')).toBe(false);
    await expectNoTokensStored(page, DROPBOX_ACCESS_TOKEN);
    expect(dropbox.apiRequests.every((r) => r.authorized)).toBe(true);
  });

  test('@security SEC-W13 a redirect with a forged state is rejected', async ({
    onboardedApp: _app,
    page,
    cloud: { dropbox },
  }) => {
    dropbox.forgeState = 'forged-state';
    const backup = new BackupPage(page);
    await backup.goto();

    await page.getByRole('button', { name: 'Connect ' + DROPBOX }).click();

    await expect(backup.provider(DROPBOX).getByRole('alert')).toHaveText(
      'The provider could not complete the request. Try again later.',
    );
    await expect(backup.provider(DROPBOX).getByText('Not connected')).toBeVisible();
    expect(dropbox.tokenRequests).toEqual([]);
  });

  test('access revoked at Dropbox → reconnect prompt', async ({
    onboardedApp: _app,
    page,
    guard,
    cloud: { dropbox },
  }) => {
    guard.expectConsoleError(/status of 401/);
    const backup = new BackupPage(page);
    await backup.goto();
    await backup.connect(DROPBOX);
    const section = backup.provider(DROPBOX);
    await expect(section.getByText('No backups yet.')).toBeVisible();
    dropbox.revoke();

    await section.getByLabel('Current passphrase').fill(TEST_PASSPHRASE);
    await section.getByRole('button', { name: 'Back up now' }).click();

    await expect(section.getByRole('alert')).toHaveText(
      'Your sign-in has expired or was revoked. Connect again.',
    );
    await expect(section.getByText('Not connected')).toBeVisible();
  });
});
