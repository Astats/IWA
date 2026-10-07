import { expect, type Locator, type Page } from '@playwright/test';

export interface CategoryInput {
  name: string;
  kind?: 'expense' | 'income';
  color?: string;
  icon?: string;
}

export class CategoriesPage {
  /** Result notice of the last action (other status regions, e.g. banners, are ignored). */
  readonly notice: Locator;

  constructor(readonly page: Page) {
    this.notice = page.getByRole('status').filter({ hasText: /^Category "/ });
  }

  list(kind: 'expense' | 'income'): Locator {
    return this.page.getByRole('list', {
      name: kind === 'expense' ? 'Expense categories' : 'Income categories',
    });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.page.getByRole('heading', { name: 'Categories', level: 1 })).toBeVisible();
    await expect(this.list('expense').getByRole('listitem').first()).toBeVisible();
  }

  async create({ name, kind = 'expense', color, icon }: CategoryInput): Promise<void> {
    await this.page
      .getByRole('button', {
        name: kind === 'expense' ? 'New expense category' : 'New income category',
      })
      .click();
    const form = this.page.getByRole('form', { name: 'Create category' });
    await form.getByLabel('Name').fill(name);
    if (color) await form.getByLabel('Color').fill(color);
    if (icon) await form.getByRole('radio', { name: icon }).check();
    await form.getByRole('button', { name: 'Create category' }).click();
    await expect(this.notice).toHaveText(`Category "${name}" created.`);
  }

  async edit(current: string, changes: { name?: string; color?: string }): Promise<void> {
    await this.page.getByRole('button', { name: `Edit ${current}`, exact: true }).click();
    const form = this.page.getByRole('form', { name: 'Save' });
    if (changes.name !== undefined) await form.getByLabel('Name').fill(changes.name);
    if (changes.color) await form.getByLabel('Color').fill(changes.color);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(this.notice).toHaveText(`Category "${changes.name ?? current}" saved.`);
  }

  deletePanel(name: string): Locator {
    return this.page.getByRole('group', { name: `Delete ${name}` });
  }

  async startDelete(name: string): Promise<Locator> {
    await this.page.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
    const panel = this.deletePanel(name);
    await expect(panel).toBeVisible();
    return panel;
  }
}
