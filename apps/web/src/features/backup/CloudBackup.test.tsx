import { createBackup, readBackup } from '@budget/backup';
import { FakeBackupProvider } from '@budget/backup/testing';
import type { Repositories } from '@budget/core';
import { createInMemoryRepositories, testKdfParams } from '@budget/core/testing';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { axe } from '@/test/axe';
import { createFakeServices, TEST_PASSPHRASE } from '@/test/fake-services';
import { renderApp } from '@/test/render';

const fileName = (day: number) => `budget-backup-202603${String(day).padStart(2, '0')}-090000.bgtb`;

async function seed(repos: Repositories, note: string) {
  await repos.categories.seedDefaults();
  const food = (await repos.categories.list()).find((c) => c.name === 'Food')!;
  return repos.transactions.create({
    kind: 'expense',
    amountMinor: 1250,
    currency: 'EUR',
    categoryId: food.id,
    date: '2026-03-01',
    note,
  });
}

function setup(provider = new FakeBackupProvider()) {
  const services = createFakeServices({ providers: [provider] });
  // A ticking clock, so consecutive backups get distinct file names.
  let tick = Date.parse('2026-03-15T10:00:00Z');
  services.now = () => new Date((tick += 1000));
  return { services, provider };
}

async function panel() {
  return screen.findByRole('region', { name: /Test storage/ });
}

async function connect(app: ReturnType<typeof renderApp>) {
  await app.user.click(await screen.findByRole('button', { name: 'Connect Test storage' }));
  const region = await panel();
  await within(region).findByText('Connected');
  return region;
}

async function backUpNow(app: ReturnType<typeof renderApp>, passphrase = TEST_PASSPHRASE) {
  const region = await panel();
  await app.user.type(within(region).getByLabelText('Current passphrase'), passphrase);
  await app.user.click(within(region).getByRole('button', { name: 'Back up now' }));
}

describe('cloud backup', () => {
  it('says so when the build has no providers', async () => {
    renderApp({ route: '/backup' });

    expect(
      await screen.findByText('No cloud providers are set up in this version of the app.'),
    ).toBeInTheDocument();
  });

  it('connects and shows an empty app folder', async () => {
    const { services } = setup();
    const app = renderApp({ services, route: '/backup' });

    const region = await panel();
    expect(within(region).getByText('Not connected')).toBeInTheDocument();
    await connect(app);

    expect(await within(region).findByText('No backups yet.')).toBeInTheDocument();
  });

  it('backs up encrypted data, then lists it as the last backup', async () => {
    const { services, provider } = setup();
    await seed(services.vault.repos, 'Secret lunch');
    const app = renderApp({ services, route: '/backup' });
    const region = await connect(app);

    await backUpNow(app);

    expect(await within(region).findByText('Backed up to Test storage.')).toBeInTheDocument();
    const [stored] = [...provider.files.values()];
    expect(stored?.name).toMatch(/^budget-backup-\d{8}-\d{6}\.bgtb$/);
    expect(new TextDecoder().decode(stored!.bytes)).not.toContain('Secret lunch');
    const { payload } = await readBackup(stored!.bytes, TEST_PASSPHRASE, {
      minKdf: testKdfParams,
    });
    expect(payload.transactions.map((t) => t.note)).toEqual(['Secret lunch']);
    expect(await within(region).findByText(/^Last backup: /)).toBeInTheDocument();
    const list = within(region).getByRole('list', { name: 'Backups in Test storage' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });

  it('requires the current passphrase to back up', async () => {
    const { services, provider } = setup();
    const app = renderApp({ services, route: '/backup' });
    const region = await connect(app);

    await backUpNow(app, 'not my passphrase');

    expect(await within(region).findByRole('alert')).toHaveTextContent(
      'That is not your current passphrase.',
    );
    expect(provider.files.size).toBe(0);
  });

  it('keeps only the configured number of backups', async () => {
    const { services, provider } = setup(new FakeBackupProvider({ connected: true }));
    provider.seed(fileName(1), new Uint8Array(10));
    provider.seed(fileName(2), new Uint8Array(10));
    const app = renderApp({ services, route: '/backup' });

    const retention = await screen.findByLabelText('Backups to keep per provider');
    expect(retention).toHaveValue(10);
    await app.user.clear(retention);
    await app.user.type(retention, '0');
    expect(await screen.findByText('Enter a whole number from 1 to 100.')).toBeInTheDocument();
    await app.user.clear(retention);
    await app.user.type(retention, '2');
    await app.user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved');
    expect(await services.vault.repos.settings.get('backupRetention')).toBe(2);

    await backUpNow(app);

    const region = await panel();
    expect(
      await within(region).findByText('Backed up to Test storage. 1 older backup was deleted.'),
    ).toBeInTheDocument();
    expect([...provider.files.values()].map((f) => f.name)).not.toContain(fileName(1));
    expect(provider.files.size).toBe(2);
  });

  it('restores a cloud backup (replace) after confirmation', async () => {
    const source = createInMemoryRepositories();
    await seed(source, 'From the cloud');
    const { services, provider } = setup(new FakeBackupProvider({ connected: true }));
    provider.seed(
      fileName(3),
      await createBackup(source, TEST_PASSPHRASE, { kdfParams: testKdfParams }),
    );
    await seed(services.vault.repos, 'Local only');
    const app = renderApp({ services, route: '/backup' });
    const region = await panel();

    await app.user.click(await within(region).findByRole('button', { name: /^Restore backup of/ }));
    await app.user.type(within(region).getByLabelText('Backup passphrase'), TEST_PASSPHRASE);
    await app.user.click(within(region).getByRole('radio', { name: /^Replace/ }));
    await app.user.click(within(region).getByRole('button', { name: 'Open backup' }));
    const confirm = await within(region).findByRole('group', { name: 'Confirm restore' });
    await app.user.click(within(confirm).getByRole('button', { name: 'Replace all data' }));

    expect(
      await within(region).findByText('Backup restored. Your data was replaced.'),
    ).toBeInTheDocument();
    expect((await services.vault.repos.transactions.list({})).items.map((t) => t.note)).toEqual([
      'From the cloud',
    ]);
    expect(await services.vault.readFile('pre-restore.bgtb')).not.toBeNull();
    await app.user.click(within(region).getByRole('button', { name: 'Close' }));
    expect(within(region).queryByLabelText('Backup passphrase')).toBeNull();
  });

  it('deletes a cloud backup only after confirmation', async () => {
    const { services, provider } = setup(new FakeBackupProvider({ connected: true }));
    provider.seed(fileName(4), new Uint8Array(10));
    const app = renderApp({ services, route: '/backup' });
    const region = await panel();

    await app.user.click(await within(region).findByRole('button', { name: /^Delete backup of/ }));
    const confirm = within(region).getByRole('group', { name: 'Confirm delete' });
    await app.user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(provider.files.size).toBe(1);

    await app.user.click(within(region).getByRole('button', { name: /^Delete backup of/ }));
    await app.user.click(within(region).getByRole('button', { name: 'Delete backup' }));

    expect(await within(region).findByText('No backups yet.')).toBeInTheDocument();
    expect(provider.files.size).toBe(0);
  });

  it('a revoked session shows as disconnected with a reconnect hint', async () => {
    const { services, provider } = setup(new FakeBackupProvider({ connected: true }));
    provider.failNext('list', 'AUTH_REQUIRED');
    renderApp({ services, route: '/backup' });
    const region = await panel();

    expect(await within(region).findByRole('alert')).toHaveTextContent(
      'Your sign-in has expired or was revoked. Connect again.',
    );
    expect(within(region).getByText('Not connected')).toBeInTheDocument();
    expect(
      within(region).getByRole('button', { name: 'Connect Test storage' }),
    ).toBeInTheDocument();
  });

  it('an expired session during a backup asks to connect again', async () => {
    const { services, provider } = setup(new FakeBackupProvider({ connected: true }));
    const app = renderApp({ services, route: '/backup' });
    const region = await panel();
    await within(region).findByText('No backups yet.');
    provider.failNext('upload', 'AUTH_REQUIRED');

    await backUpNow(app);

    expect(await within(region).findByRole('alert')).toHaveTextContent(
      'Your sign-in has expired or was revoked. Connect again.',
    );
    expect(within(region).getByText('Not connected')).toBeInTheDocument();
  });

  it('a cancelled sign-in stays disconnected', async () => {
    const { services } = setup(new FakeBackupProvider().failNext('connect', 'CANCELLED'));
    const app = renderApp({ services, route: '/backup' });

    await app.user.click(await screen.findByRole('button', { name: 'Connect Test storage' }));

    const region = await panel();
    expect(await within(region).findByRole('alert')).toHaveTextContent('Sign-in was cancelled.');
    expect(within(region).getByText('Not connected')).toBeInTheDocument();
  });

  it('a backup deleted elsewhere is reported and the list refreshes', async () => {
    const { services, provider } = setup(new FakeBackupProvider({ connected: true }));
    const item = provider.seed(fileName(5), new Uint8Array(10));
    const app = renderApp({ services, route: '/backup' });
    const region = await panel();
    await app.user.click(await within(region).findByRole('button', { name: /^Restore backup of/ }));
    provider.files.delete(item.id);

    await app.user.type(within(region).getByLabelText('Backup passphrase'), TEST_PASSPHRASE);
    await app.user.click(within(region).getByRole('button', { name: 'Open backup' }));

    expect(await within(region).findByRole('alert')).toHaveTextContent(
      'That backup no longer exists.',
    );
    expect(await within(region).findByText('No backups yet.')).toBeInTheDocument();
  });

  it('network failures show a generic, translated message', async () => {
    const { services, provider } = setup(new FakeBackupProvider({ connected: true }));
    const app = renderApp({ services, route: '/backup' });
    const region = await panel();
    await within(region).findByText('No backups yet.');
    provider.failNext('upload', 'NETWORK');

    await backUpNow(app);

    expect(await within(region).findByRole('alert')).toHaveTextContent(
      'Could not reach the provider. Check your connection.',
    );
    expect(within(region).getByText('Connected')).toBeInTheDocument();
  });

  it('disconnect forgets the session', async () => {
    const { services, provider } = setup(new FakeBackupProvider({ connected: true }));
    const app = renderApp({ services, route: '/backup' });

    await app.user.click(await screen.findByRole('button', { name: 'Disconnect Test storage' }));

    expect(
      await screen.findByText('Disconnected from Test storage on this device.'),
    ).toBeInTheDocument();
    expect(provider.isConnected()).toBe(false);
  });

  it('locking the app drops every provider session', async () => {
    const { services, provider } = setup(new FakeBackupProvider({ connected: true }));
    const app = renderApp({ services, route: '/backup' });
    await panel();

    await app.user.click(screen.getByRole('button', { name: 'Lock' }));

    await waitFor(() => {
      expect(provider.isConnected()).toBe(false);
    });
  });

  it('has no axe violations when connected with backups', async () => {
    const { services, provider } = setup(new FakeBackupProvider({ connected: true }));
    provider.seed(fileName(6), new Uint8Array(2_500_000));
    const app = renderApp({ services, route: '/backup' });
    const region = await panel();
    await within(region).findByText(/\(2\.5 MB\)/);

    expect(await axe(app.container)).toHaveNoViolations();
  });
});
