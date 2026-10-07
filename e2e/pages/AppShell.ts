import { expect, type Page } from '@playwright/test';

/** Navigation and lock controls shared by all unlocked screens. */
export class AppShell {
  constructor(readonly page: Page) {}

  async navigate(
    name: 'Dashboard' | 'Transactions' | 'Categories' | 'Import / Export' | 'Backup' | 'Settings',
  ): Promise<void> {
    await this.page
      .getByRole('navigation', { name: 'Main' })
      .filter({ visible: true })
      .getByRole('link', { name })
      .click();
    await expect(this.page.getByRole('heading', { name, level: 1 })).toBeVisible();
  }

  async lock(): Promise<void> {
    await this.page.getByRole('button', { name: 'Lock' }).filter({ visible: true }).first().click();
    await expect(this.page.getByRole('heading', { name: 'Unlock Budget' })).toBeVisible();
  }
}
