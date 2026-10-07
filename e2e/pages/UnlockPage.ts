import { expect, type Locator, type Page } from '@playwright/test';

export class UnlockPage {
  readonly heading: Locator;
  readonly passphrase: Locator;
  readonly submit: Locator;
  readonly error: Locator;

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Unlock Budget' });
    this.passphrase = page.getByLabel('Passphrase', { exact: true });
    this.submit = page.getByRole('button', { name: 'Unlock' });
    this.error = page.getByRole('alert');
  }

  async expectLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible();
  }

  async unlock(passphrase: string): Promise<void> {
    await this.passphrase.fill(passphrase);
    await this.submit.click();
  }
}
