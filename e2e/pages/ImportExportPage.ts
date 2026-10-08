import { readFileSync } from 'node:fs';

import { expect, type Locator, type Page } from '@playwright/test';

export class ImportExportPage {
  readonly fileInput: Locator;
  readonly previewButton: Locator;
  readonly preview: Locator;

  constructor(readonly page: Page) {
    this.fileInput = page.getByLabel('CSV file');
    this.previewButton = page.getByRole('button', { name: 'Preview' });
    this.preview = page.getByRole('region', { name: 'Import preview' });
  }

  async goto(): Promise<void> {
    await this.page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Import / Export' })
      .click();
    await expect(
      this.page.getByRole('heading', { name: 'Import / Export', level: 1 }),
    ).toBeVisible();
  }

  count(key: 'valid' | 'invalid' | 'duplicates' | 'newCategories'): Locator {
    return this.page.getByTestId(`count-${key}`);
  }

  async choose(name: string, content: string | Buffer): Promise<void> {
    await this.fileInput.setInputFiles({
      name,
      mimeType: 'text/csv',
      buffer: Buffer.from(content),
    });
    await this.previewButton.click();
  }

  async importFile(
    name: string,
    content: string | Buffer,
    { createCategories = false } = {},
  ): Promise<number> {
    await this.choose(name, content);
    await expect(this.preview).toBeVisible({ timeout: 60_000 });
    if (createCategories)
      await this.page.getByRole('checkbox', { name: /Create missing categories/ }).check();
    const commit = this.page.getByRole('button', { name: /^Import \d+ transaction/ });
    const count = Number(/\d+/.exec((await commit.textContent()) ?? '')?.[0] ?? 0);
    await commit.click();
    await expect(this.page.getByText(`Imported ${count} transaction(s).`)).toBeVisible({
      timeout: 60_000,
    });
    return count;
  }

  /** Clicks a button that triggers a download and returns the file's text. */
  async download(button: string | RegExp): Promise<{ name: string; text: string }> {
    const [download] = await Promise.all([
      this.page.waitForEvent('download'),
      this.page.getByRole('button', { name: button }).click(),
    ]);
    return {
      name: download.suggestedFilename(),
      text: readFileSync(await download.path(), 'utf8'),
    };
  }
}

/** Deterministic CSV with `n` rows over the default categories (seeding through the real import). */
export function generateCsv(n: number, seed = 1): string {
  const expense = [
    'Housing',
    'Food',
    'Transport',
    'Utilities',
    'Health',
    'Entertainment',
    'Shopping',
    'Other',
  ];
  const income = ['Salary', 'Freelance', 'Gifts', 'Interest'];
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2 ** 31);
  const lines = ['date,kind,amount,currency,category,note,id'];
  for (let i = 0; i < n; i++) {
    const isIncome = next() % 5 === 0;
    const category = isIncome ? income[next() % income.length] : expense[next() % expense.length];
    const month = String((next() % 12) + 1).padStart(2, '0');
    const day = String((next() % 28) + 1).padStart(2, '0');
    const amount = `${(next() % 50_000) + 1}.${String(next() % 100).padStart(2, '0')}`;
    lines.push(
      `2025-${month}-${day},${isIncome ? 'income' : 'expense'},${amount},EUR,${category},row ${i},`,
    );
  }
  return `${lines.join('\n')}\n`;
}
