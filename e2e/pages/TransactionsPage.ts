import { expect, type Locator, type Page } from '@playwright/test';

import { TransactionFormPage, type TransactionInput } from './TransactionFormPage';

export class TransactionsPage {
  readonly form: TransactionFormPage;

  constructor(readonly page: Page) {
    this.form = new TransactionFormPage(page);
  }

  async goto(): Promise<void> {
    await this.page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Transactions' })
      .click();
    await expect(this.page.getByRole('heading', { name: 'Transactions', level: 1 })).toBeVisible();
  }

  /** Rows of the transaction list (links to the edit page). */
  rows(): Locator {
    return this.page.getByRole('list', { name: 'Transactions' }).getByRole('link');
  }

  row(text: string | RegExp): Locator {
    return this.rows().filter({ hasText: text });
  }

  async add(input: TransactionInput): Promise<void> {
    await this.page.getByRole('link', { name: 'New transaction' }).click();
    await expect(
      this.page.getByRole('heading', { name: 'New transaction', level: 1 }),
    ).toBeVisible();
    await this.form.fill(input);
    await this.form.submit();
  }

  async addExpense(input: Omit<TransactionInput, 'kind'>): Promise<void> {
    await this.add({ ...input, kind: 'expense' });
  }

  async addIncome(input: Omit<TransactionInput, 'kind'>): Promise<void> {
    await this.add({ ...input, kind: 'income' });
  }

  async open(text: string | RegExp): Promise<void> {
    await this.row(text).click();
    await expect(
      this.page.getByRole('heading', { name: 'Edit transaction', level: 1 }),
    ).toBeVisible();
  }

  toast(text: string | RegExp): Locator {
    return this.page.getByRole('status').filter({ hasText: text });
  }
}
