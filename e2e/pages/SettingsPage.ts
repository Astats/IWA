import { expect, type Locator, type Page } from '@playwright/test';

export class SettingsPage {
  readonly baseCurrency: Locator;
  readonly language: Locator;
  readonly theme: Locator;
  readonly autoLock: Locator;
  readonly save: Locator;

  constructor(readonly page: Page) {
    this.baseCurrency = page.getByLabel('Base currency');
    this.language = page.getByLabel('Language and region');
    this.theme = page.getByLabel('Theme');
    this.autoLock = page.getByLabel('Auto-lock after (minutes)');
    this.save = page.getByRole('button', { name: 'Save' });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(this.baseCurrency).toBeVisible();
  }

  async saveSettings(): Promise<void> {
    await this.save.click();
    await expect(
      this.page.getByRole('status').filter({ hasText: 'Settings saved.' }),
    ).toBeVisible();
  }

  async changePassphrase(current: string, next: string): Promise<void> {
    await this.page.getByLabel('Current passphrase').fill(current);
    await this.page.getByLabel('New passphrase', { exact: true }).fill(next);
    await this.page.getByLabel('Repeat passphrase', { exact: true }).fill(next);
    await this.page.getByRole('button', { name: 'Change passphrase' }).click();
  }
}
