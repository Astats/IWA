import { readFileSync } from 'node:fs';

import type { Page } from '@playwright/test';

import { expect, test } from '../fixtures/app.fixture';
import { TransactionsPage } from '../pages/TransactionsPage';

/** Clicks `button`, waits for the download and returns the saved file's text (BOM kept). */
export async function downloadText(
  page: Page,
  button: string,
): Promise<{ name: string; text: string }> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: button }).click(),
  ]);
  const path = await download.path();
  return { name: download.suggestedFilename(), text: readFileSync(path, 'utf8') };
}

/** Minimal RFC 4180 reader for assertions (independent of the app's parser). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const body = text.replace(/^\ufeff/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && body[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += c;
  }
  return rows;
}

test.describe('CSV export', () => {
  test('@security SEC-W10 exported cells are escaped against formula injection', async ({
    onboardedApp: app,
    page,
  }) => {
    const tx = new TransactionsPage(page);
    await tx.goto();
    const dangerous = [
      '=HYPERLINK("http://example.invalid","x")',
      '+SUM(1,2)',
      '-2+3',
      '@cmd',
      'normal, with "quotes"',
    ];
    for (const note of dangerous) await tx.addExpense({ amount: '1.00', category: 'Food', note });
    await app.shell.navigate('Import / Export');

    const { name, text } = await downloadText(page, 'Export all transactions');

    expect(name).toMatch(/^budget-transactions-\d{8}-\d{6}\.csv$/);
    expect(text.startsWith('\ufeffdate,kind,amount,currency,category,note,id\r\n')).toBe(true);
    const rows = parseCsv(text);
    const notes = rows.slice(1).map((r) => r[5]);
    for (const note of dangerous.slice(0, 4)) expect(notes).toContain(`'${note}`);
    expect(notes).toContain('normal, with "quotes"');
    for (const row of rows.slice(1)) {
      expect(row[2]).toBe('1.00'); // plain positive amount, never signed
      expect(row).toHaveLength(7);
    }
  });
});
