import { expect, type Locator, type Page } from '@playwright/test';

import { AppShell } from './AppShell';

/** Backup screen: cloud providers (Phase 3) plus local file backup/restore. */
export class BackupPage {
  constructor(readonly page: Page) {}

  async goto(): Promise<void> {
    await new AppShell(this.page).navigate('Backup');
  }

  /** The section of one cloud provider, e.g. "Test storage" or "Microsoft OneDrive". */
  provider(name: string): Locator {
    return this.page.getByRole('region', { name: new RegExp(`^${name}`) });
  }

  remoteItems(name: string): Locator {
    return this.provider(name)
      .getByRole('list', { name: `Backups in ${name}` })
      .getByRole('listitem');
  }

  async connect(name: string): Promise<void> {
    await this.page.getByRole('button', { name: `Connect ${name}` }).click();
    await expect(this.provider(name).getByText('Connected', { exact: true })).toBeVisible();
  }

  async disconnect(name: string): Promise<void> {
    await this.page.getByRole('button', { name: `Disconnect ${name}` }).click();
    await expect(this.provider(name).getByText('Not connected')).toBeVisible();
  }

  async backUpNow(name: string, passphrase: string): Promise<void> {
    const section = this.provider(name);
    await section.getByLabel('Current passphrase').fill(passphrase);
    await section.getByRole('button', { name: 'Back up now' }).click();
    await expect(section.getByText(`Backed up to ${name}.`)).toBeVisible({ timeout: 30_000 });
  }

  /** Restores the remote backup at `index` (0 = newest). */
  async restoreRemote(
    name: string,
    index: number,
    passphrase: string,
    mode: 'Merge' | 'Replace',
  ): Promise<void> {
    const item = this.remoteItems(name).nth(index);
    await item.getByRole('button', { name: /^Restore backup of/ }).click();
    await item.getByLabel('Backup passphrase').fill(passphrase);
    await item.getByRole('radio', { name: new RegExp(`^${mode}`) }).check();
    await item.getByRole('button', { name: 'Open backup' }).click();
    const confirm = item.getByRole('group', { name: 'Confirm restore' });
    await confirm
      .getByRole('button', { name: mode === 'Replace' ? 'Replace all data' : 'Merge backup' })
      .click();
    await expect(
      item.getByText(
        mode === 'Replace'
          ? 'Backup restored. Your data was replaced.'
          : 'Backup merged into your data.',
      ),
    ).toBeVisible({ timeout: 30_000 });
  }

  async deleteRemote(name: string, index: number): Promise<void> {
    const item = this.remoteItems(name).nth(index);
    await item.getByRole('button', { name: /^Delete backup of/ }).click();
    await item.getByRole('button', { name: 'Delete backup' }).click();
  }
}
