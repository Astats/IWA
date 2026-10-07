import { expect, test, TEST_PASSPHRASE } from '../fixtures/app.fixture';
import { TransactionsPage } from '../pages/TransactionsPage';

test.describe('J5 transaction list', () => {
  test('@smoke @security sorts every column, filters, keeps filters in the URL but never the search term', async ({
    onboardedApp: app,
    page,
  }) => {
    const tx = new TransactionsPage(page);
    await tx.goto();
    await tx.addExpense({ amount: '5.00', category: 'Food', date: '2026-03-02', note: 'Bakery' });
    await tx.addExpense({
      amount: '1200.00',
      category: 'Housing',
      date: '2026-03-01',
      note: 'Rent March',
    });
    await tx.addIncome({
      amount: '3000.00',
      category: 'Salary',
      date: '2026-02-28',
      note: 'Salary Feb',
    });
    await tx.addExpense({
      amount: '25.00',
      category: 'Transport',
      date: '2026-02-10',
      note: 'Train',
    });

    // Default: date descending.
    await expect.poll(() => tx.notes()).toEqual(['Bakery', 'Rent March', 'Salary Feb', 'Train']);

    // Each sortable column, ascending then descending.
    const table = page.getByRole('table', { name: 'Transactions' });
    const expected: Record<string, [string[], string[]]> = {
      Date: [
        ['Train', 'Salary Feb', 'Rent March', 'Bakery'],
        ['Bakery', 'Rent March', 'Salary Feb', 'Train'],
      ],
      Amount: [
        ['Bakery', 'Train', 'Rent March', 'Salary Feb'],
        ['Salary Feb', 'Rent March', 'Train', 'Bakery'],
      ],
      Category: [
        ['Bakery', 'Rent March', 'Salary Feb', 'Train'],
        ['Train', 'Salary Feb', 'Rent March', 'Bakery'],
      ],
    };
    for (const [column, [asc, desc]] of Object.entries(expected)) {
      const header = table.getByRole('button', { name: column });
      await header.click();
      if (
        (await table.getByRole('columnheader', { name: column }).getAttribute('aria-sort')) ===
        'descending'
      ) {
        await header.click(); // Date starts descending; one more click for ascending.
      }
      await expect(table.getByRole('columnheader', { name: column })).toHaveAttribute(
        'aria-sort',
        'ascending',
      );
      await expect.poll(() => tx.notes()).toEqual(asc);
      await header.click();
      await expect(table.getByRole('columnheader', { name: column })).toHaveAttribute(
        'aria-sort',
        'descending',
      );
      await expect.poll(() => tx.notes()).toEqual(desc);
    }
    await table.getByRole('button', { name: 'Type' }).click();
    await expect.poll(async () => (await tx.notes()).at(-1)).toBe('Salary Feb');
    await table.getByRole('button', { name: 'Type' }).click();
    await expect.poll(async () => (await tx.notes())[0]).toBe('Salary Feb');

    // Filters: kind, category, date range, search.
    await page.getByRole('button', { name: 'Reset filters' }).click();
    await page.getByLabel('Type').selectOption('expense');
    await expect.poll(() => tx.notes()).toEqual(['Bakery', 'Rent March', 'Train']);
    await page.getByText(/Categories \(\d+ selected\)/).click();
    await page.getByRole('checkbox', { name: 'Housing' }).check();
    await page.getByRole('checkbox', { name: 'Food' }).check();
    await expect.poll(() => tx.notes()).toEqual(['Bakery', 'Rent March']);
    await page.getByLabel('Period').selectOption('custom');
    await page.getByLabel('From').fill('2026-03-02');
    await page.getByLabel('To').fill('2026-03-31');
    await expect.poll(() => tx.notes()).toEqual(['Bakery']);
    await page.getByLabel('Period').selectOption('');
    const secret = 'Rent';
    await page.getByLabel('Search notes').fill(secret);
    await expect.poll(() => tx.notes()).toEqual(['Rent March']);

    // SEC-W04: the search term never reaches the URL or history.
    expect(page.url()).not.toContain(secret);
    expect(page.url()).not.toMatch(/[?&](q|search)=/);
    expect(await page.evaluate(() => history.length)).toBeGreaterThan(0);

    // Filters survive a reload (URL), the search term does not.
    const urlBefore = page.url();
    await page.reload();
    await app.unlock.unlock(TEST_PASSPHRASE);
    await expect(page.getByRole('heading', { name: 'Transactions', level: 1 })).toBeVisible();
    expect(page.url()).toBe(urlBefore);
    await expect(page.getByLabel('Type')).toHaveValue('expense');
    await expect(page.getByLabel('Search notes')).toHaveValue('');
    await expect.poll(() => tx.notes()).toEqual(['Bakery', 'Rent March']);
  });

  test('a small screen shows cards instead of a table', async ({ onboardedApp: app, page }) => {
    const tx = new TransactionsPage(page);
    await tx.goto();
    await tx.addExpense({ amount: '9.99', category: 'Food', note: 'Pizza' });

    await page.setViewportSize({ width: 375, height: 800 });

    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(
      page.getByRole('list', { name: 'Transactions' }).getByRole('link', { name: /Pizza/ }),
    ).toBeVisible();
    await expect(page.getByLabel('Sort by')).toBeVisible();
    await app.shell.navigate('Transactions');
  });
});
