import { createBackup, readBackup } from '@budget/backup';
import type { Repositories } from '@budget/core';
import { createInMemoryRepositories, testKdfParams } from '@budget/core/testing';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { axe } from '@/test/axe';
import { createFakeServices, TEST_PASSPHRASE } from '@/test/fake-services';
import { renderApp } from '@/test/render';

let downloads: Array<{ name: string; blob: Blob }>;

beforeEach(() => {
  downloads = [];
  const blobs = new Map<string, Blob>();
  let n = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn((blob: Blob) => {
        const url = `blob:test/${++n}`;
        blobs.set(url, blob);
        return url;
      }),
      revokeObjectURL: vi.fn(),
    }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobs.get(this.href);
    if (blob) downloads.push({ name: this.download, blob });
  });
});

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

async function backupFileOf(repos: Repositories, passphrase = TEST_PASSPHRASE) {
  const bytes = await createBackup(repos, passphrase, { kdfParams: testKdfParams });
  return new File([new Uint8Array(bytes)], 'budget-backup-20260315-100000.bgtb');
}

async function openRestore(
  app: ReturnType<typeof renderApp>,
  file: File,
  passphrase: string,
  mode?: 'Merge' | 'Replace',
) {
  await app.user.upload(await screen.findByLabelText('Backup file'), file);
  await app.user.type(screen.getByLabelText('Backup passphrase'), passphrase);
  if (mode) await app.user.click(screen.getByRole('radio', { name: new RegExp(`^${mode}`) }));
  await app.user.click(screen.getByRole('button', { name: 'Open backup' }));
}

describe('download backup', () => {
  it('requires the current passphrase', async () => {
    const app = renderApp({ route: '/backup' });

    await app.user.type(await screen.findByLabelText('Current passphrase'), 'not my passphrase');
    await app.user.click(screen.getByRole('button', { name: 'Download backup file' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That is not your current passphrase.',
    );
    expect(downloads).toEqual([]);
  });

  it('downloads an encrypted .bgtb that restores to the same data', async () => {
    const services = createFakeServices();
    await seed(services.vault.repos, 'Lunch');
    const app = renderApp({ services, route: '/backup' });

    await app.user.type(await screen.findByLabelText('Current passphrase'), TEST_PASSPHRASE);
    await app.user.click(screen.getByRole('button', { name: 'Download backup file' }));

    expect(await screen.findByText('Backup downloaded.')).toBeInTheDocument();
    const file = downloads[0]!;
    expect(file.name).toMatch(/^budget-backup-20260315-\d{6}\.bgtb$/);
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).not.toContain('Lunch');
    const { payload } = await readBackup(bytes, TEST_PASSPHRASE, { minKdf: testKdfParams });
    expect(payload.transactions.map((t) => t.note)).toEqual(['Lunch']);
  });
});

describe('restore backup', () => {
  it('replace: confirms, saves a pre-restore copy, then replaces all data', async () => {
    const source = createInMemoryRepositories();
    await seed(source, 'From backup');
    const services = createFakeServices();
    await seed(services.vault.repos, 'Local only');
    const app = renderApp({ services, route: '/backup' });

    await openRestore(app, await backupFileOf(source), TEST_PASSPHRASE, 'Replace');

    const confirm = await screen.findByRole('group', { name: 'Confirm restore' });
    expect(within(confirm).getByText(/1 transaction\(s\), 13 categories/)).toBeInTheDocument();
    expect(
      within(confirm).getByText(/All data on this device will be replaced/),
    ).toBeInTheDocument();
    await app.user.click(within(confirm).getByRole('button', { name: 'Replace all data' }));

    expect(await screen.findByText('Backup restored. Your data was replaced.')).toBeInTheDocument();
    expect((await services.vault.repos.transactions.list({})).items.map((t) => t.note)).toEqual([
      'From backup',
    ]);
    const preRestore = await services.vault.readFile('pre-restore.bgtb');
    const { payload } = await readBackup(preRestore!, TEST_PASSPHRASE, { minKdf: testKdfParams });
    expect(payload.transactions.map((t) => t.note)).toEqual(['Local only']);
    await app.user.click(
      screen.getByRole('button', { name: 'Download the copy of your previous data' }),
    );
    expect(downloads[0]?.name).toMatch(/^budget-pre-restore-\d{8}-\d{6}\.bgtb$/);
  });

  it('merge keeps local data and adds the backup rows', async () => {
    const source = createInMemoryRepositories();
    await seed(source, 'From backup');
    const services = createFakeServices();
    await seed(services.vault.repos, 'Local only');
    const app = renderApp({ services, route: '/backup' });

    await openRestore(app, await backupFileOf(source), TEST_PASSPHRASE);
    await app.user.click(await screen.findByRole('button', { name: 'Merge backup' }));

    expect(await screen.findByText('Backup merged into your data.')).toBeInTheDocument();
    expect(
      (await services.vault.repos.transactions.list({})).items.map((t) => t.note).sort(),
    ).toEqual(['From backup', 'Local only']);
  });

  it.each([
    [
      'a wrong passphrase',
      async () => backupFileOf(createInMemoryRepositories(), 'some other passphrase'),
      'Wrong passphrase, or the file is damaged.',
    ],
    [
      'a non-backup file',
      // A .bgtb name (the file input only accepts backups) with non-backup content.
      () => Promise.resolve(new File(['date,kind\n'], 'not-really.bgtb')),
      'This is not a valid backup file.',
    ],
    [
      'a tampered file (SEC-W09)',
      async () => {
        const bytes = new Uint8Array(
          await (await backupFileOf(createInMemoryRepositories())).arrayBuffer(),
        );
        bytes[bytes.length - 3] = (bytes[bytes.length - 3] ?? 0) ^ 0xff;
        return new File([bytes], 'tampered.bgtb');
      },
      'Wrong passphrase, or the file is damaged.',
    ],
    [
      'a backup from a newer app version',
      async () => {
        const bytes = new Uint8Array(
          await (await backupFileOf(createInMemoryRepositories())).arrayBuffer(),
        );
        bytes[4] = 9;
        return new File([bytes], 'future.bgtb');
      },
      'This backup was made by a newer version of the app. Update the app to restore it.',
    ],
  ])('rejects %s with a clear message and changes nothing', async (_name, makeFile, message) => {
    const services = createFakeServices();
    await seed(services.vault.repos, 'Untouched');
    const app = renderApp({ services, route: '/backup' });

    await openRestore(app, await makeFile(), TEST_PASSPHRASE, 'Replace');

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect((await services.vault.repos.transactions.list({})).items.map((t) => t.note)).toEqual([
      'Untouched',
    ]);
    expect(await services.vault.readFile('pre-restore.bgtb')).toBeNull();
  });

  it('has no axe violations', async () => {
    const app = renderApp({ route: '/backup' });
    await screen.findByLabelText('Backup file');

    expect(await axe(app.container)).toHaveNoViolations();
  });
});
