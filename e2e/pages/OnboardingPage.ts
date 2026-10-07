import { expect, type Locator, type Page } from '@playwright/test';

export interface OnboardingInput {
  passphrase: string;
  currency?: string;
  locale?: string;
}

export class OnboardingPage {
  readonly heading: Locator;
  readonly start: Locator;
  readonly passphrase: Locator;
  readonly confirm: Locator;
  readonly acknowledge: Locator;
  readonly next: Locator;
  readonly baseCurrency: Locator;
  readonly language: Locator;
  readonly create: Locator;

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Welcome to Budget' });
    this.start = page.getByRole('button', { name: 'Get started' });
    this.passphrase = page.getByLabel('Passphrase', { exact: true });
    this.confirm = page.getByLabel('Repeat passphrase', { exact: true });
    this.acknowledge = page.getByRole('checkbox', { name: /lost passphrase means lost data/ });
    this.next = page.getByRole('button', { name: 'Next' });
    this.baseCurrency = page.getByLabel('Base currency');
    this.language = page.getByLabel('Language and region');
    this.create = page.getByRole('button', { name: 'Create my vault' });
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
    await expect(this.heading).toBeVisible();
  }

  async fillPassphraseStep(passphrase: string, confirm = passphrase): Promise<void> {
    await this.passphrase.fill(passphrase);
    await this.confirm.fill(confirm);
  }

  async complete({
    passphrase,
    currency = 'EUR',
    locale = 'en-US',
  }: OnboardingInput): Promise<void> {
    await this.start.click();
    await this.fillPassphraseStep(passphrase);
    await this.acknowledge.check();
    await this.next.click();
    await this.baseCurrency.selectOption(currency);
    await this.language.selectOption(locale);
    await this.create.click();
    await expect(this.page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({
      timeout: 20_000,
    });
  }
}
