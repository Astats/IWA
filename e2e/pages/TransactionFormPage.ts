import { expect, type Locator, type Page } from '@playwright/test';

export interface TransactionInput {
  kind?: 'expense' | 'income';
  amount: string;
  category: string;
  date?: string;
  note?: string;
  currency?: string;
}

export class TransactionFormPage {
  readonly amount: Locator;
  readonly currency: Locator;
  readonly category: Locator;
  readonly date: Locator;
  readonly note: Locator;
  readonly save: Locator;
  readonly delete: Locator;

  constructor(readonly page: Page) {
    this.amount = page.getByLabel('Amount');
    this.currency = page.getByLabel('Currency');
    this.category = page.getByLabel('Category');
    this.date = page.getByLabel('Date');
    this.note = page.getByLabel('Note');
    this.save = page.getByRole('button', { name: 'Save' });
    this.delete = page.getByRole('button', { name: 'Delete' });
  }

  async fill(input: Partial<TransactionInput>): Promise<void> {
    if (input.kind) {
      await this.page
        .getByRole('radio', { name: input.kind === 'income' ? 'Income' : 'Expense' })
        .check();
    }
    if (input.amount !== undefined) await this.amount.fill(input.amount);
    if (input.currency) await this.currency.selectOption(input.currency);
    if (input.category) await this.category.selectOption({ label: input.category });
    if (input.date) await this.date.fill(input.date);
    if (input.note !== undefined) await this.note.fill(input.note);
  }

  async submit(): Promise<void> {
    await this.save.click();
    await expect(this.page.getByRole('heading', { name: 'Transactions', level: 1 })).toBeVisible();
  }
}
