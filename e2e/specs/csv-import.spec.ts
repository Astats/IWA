import { expect, test, TEST_PASSPHRASE } from '../fixtures/app.fixture';
import { AppShell } from '../pages/AppShell';
import { ImportExportPage } from '../pages/ImportExportPage';
import { OnboardingPage } from '../pages/OnboardingPage';
import { TransactionsPage } from '../pages/TransactionsPage';

const HEADER = 'date,kind,amount,currency,category,note,id';

test.describe('CSV import', () => {
  test('@smoke J10 export → re-import into a fresh profile gives the same list and totals', async ({
    onboardedApp: app,
    page,
    browser,
  }) => {
    const tx = new TransactionsPage(page);
    await tx.goto();
    await tx.addIncome({
      amount: '3500',
      category: 'Salary',
      date: '2026-03-01',
      note: 'Salary, March',
    });
    await tx.addExpense({
      amount: '12.50',
      category: 'Food',
      date: '2026-03-02',
      note: '=SUM(1,2) "quoted"',
    });
    await tx.addExpense({
      amount: '1200',
      category: 'Housing',
      date: '2026-03-03',
      note: 'ā č ē 😀',
    });
    const notesBefore = await tx.notes();
    const importer = new ImportExportPage(page);
    await importer.goto();
    const exported = await importer.download('Export all transactions');

    // A fresh browser context = a new, empty device.
    const fresh = await browser.newContext();
    const page2 = await fresh.newPage();
    const onboarding = new OnboardingPage(page2);
    await onboarding.goto();
    await onboarding.complete({ passphrase: TEST_PASSPHRASE });
    const importer2 = new ImportExportPage(page2);
    await importer2.goto();
    expect(await importer2.importFile(exported.name, exported.text)).toBe(3);

    const tx2 = new TransactionsPage(page2);
    await tx2.goto();
    expect(await tx2.notes()).toEqual(notesBefore);
    await new AppShell(page2).navigate('Dashboard');
    await page2.getByLabel('Period').selectOption('last-12-months');
    await app.shell.navigate('Dashboard');
    await page.getByLabel('Period').selectOption('last-12-months');
    await expect(page.getByTestId('total-income-EUR')).toHaveText('€3,500.00');
    for (const field of ['income', 'expense', 'balance']) {
      await expect(page2.getByTestId(`total-${field}-EUR`)).toHaveText(
        (await page.getByTestId(`total-${field}-EUR`).textContent()) ?? '',
      );
    }
    // Re-importing the same file finds only duplicates.
    await importer2.goto();
    await importer2.choose(exported.name, exported.text);
    await expect(importer2.count('duplicates')).toHaveText('3');
    await fresh.close();
  });

  test('@smoke J11 errors are previewed, downloadable, and only valid rows are committed', async ({
    onboardedApp: app,
    page,
  }) => {
    const importer = new ImportExportPage(page);
    await importer.goto();
    const csv = [
      HEADER,
      '2026-03-01,expense,10.00,EUR,Food,good one,',
      '2026-02-30,expense,10.00,EUR,Food,bad date,',
      '2026-03-02,expense,-3,EUR,Food,negative,',
      '2026-03-03,income,50.00,EUR,Side gig,new category,',
    ].join('\n');

    await importer.choose('mixed.csv', csv);

    await expect(importer.preview).toBeVisible();
    await expect(importer.count('valid')).toHaveText('2');
    await expect(importer.count('invalid')).toHaveText('2');
    await expect(importer.count('newCategories')).toHaveText('1');
    await expect(
      page.getByRole('list', { name: 'Rows with errors (2)' }).getByRole('listitem'),
    ).toHaveText([
      'Row 3, date: Use a date in YYYY-MM-DD format.',
      'Row 4, amount: Amounts must be positive; use the kind column for expenses.',
    ]);
    const errors = await importer.download('Download errors as CSV');
    expect(errors.text).toBe(
      '\ufeffrow,field,message\r\n3,date,Use a date in YYYY-MM-DD format.\r\n4,amount,Amounts must be positive; use the kind column for expenses.\r\n',
    );

    await page.getByRole('checkbox', { name: /Create missing categories: Side gig/ }).check();
    await page.getByRole('button', { name: 'Import 2 transaction(s)' }).click();
    await expect(page.getByText('Imported 2 transaction(s).')).toBeVisible();

    const tx = new TransactionsPage(page);
    await tx.goto();
    expect((await tx.notes()).sort()).toEqual(['good one', 'new category']);
    await app.shell.navigate('Categories');
    await expect(
      page.getByRole('list', { name: 'Income categories' }).getByText('Side gig'),
    ).toBeVisible();
  });

  test('@security SEC-W11 an oversized file is rejected without freezing the UI', async ({
    onboardedApp: _app,
    page,
  }) => {
    const importer = new ImportExportPage(page);
    await importer.goto();
    const big = `${HEADER}\n${'2026-03-01,expense,1.00,EUR,Food,xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx,\n'.repeat(80_000)}`;
    expect(big.length).toBeGreaterThan(5 * 1024 * 1024);

    await importer.choose('too-large.csv', big);

    await expect(page.getByRole('alert')).toHaveText('The file is larger than 5 MB.');
    // The page stays responsive.
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Dashboard' })
      .click();
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  });

  test('@security SEC-W11 more than 50,000 rows is rejected', async ({
    onboardedApp: _app,
    page,
  }) => {
    const importer = new ImportExportPage(page);
    await importer.goto();

    await importer.choose(
      'too-many-rows.csv',
      `${HEADER}\n${'2026-03-01,expense,1,EUR,Food,,\n'.repeat(50_001)}`,
    );

    await expect(page.getByRole('alert')).toHaveText('The file has more than 50,000 rows.', {
      timeout: 30_000,
    });
  });
});

test.describe('@perf transaction list with 10,000 rows', () => {
  test.use({ seedRows: 10_000 });

  test('first page renders within 300 ms of navigation; sort change within 200 ms', async ({
    seededApp: _app,
    page,
  }) => {
    test.setTimeout(180_000);
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Dashboard' })
      .click();

    const start = Date.now();
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Transactions' })
      .click();
    await expect(page.getByText('1–50 of 10000')).toBeVisible();
    await expect(
      page.getByRole('table', { name: 'Transactions' }).getByRole('row').nth(50),
    ).toBeVisible();
    const firstPageMs = Date.now() - start;

    const sortStart = Date.now();
    await page
      .getByRole('table', { name: 'Transactions' })
      .getByRole('button', { name: 'Amount' })
      .click();
    await expect(page.getByRole('columnheader', { name: 'Amount' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    await expect(
      page.getByRole('table', { name: 'Transactions' }).getByRole('row').nth(1),
    ).toContainText('€');
    const sortMs = Date.now() - sortStart;

    test.info().annotations.push({
      type: 'perf',
      description: `first page ${firstPageMs} ms, sort ${sortMs} ms`,
    });
    console.log(`[perf] 10k rows UI: first page ${firstPageMs} ms, sort ${sortMs} ms`);
    expect(firstPageMs).toBeLessThan(300);
    expect(sortMs).toBeLessThan(200);
  });
});
