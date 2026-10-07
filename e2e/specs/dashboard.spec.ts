import type { Page } from '@playwright/test';

import { expect, test, TEST_PASSPHRASE } from '../fixtures/app.fixture';
import { TransactionsPage } from '../pages/TransactionsPage';

const tile = (page: Page, field: 'income' | 'expense' | 'balance', currency = 'EUR') =>
  page.getByTestId(`total-${field}-${currency}`);

test.describe('dashboard', () => {
  test.beforeEach(async ({ page, app }) => {
    // Deterministic "today" so the period presets are stable.
    await page.clock.setFixedTime(new Date('2026-03-15T10:00:00'));
    await app.onboarding.goto();
    await app.onboarding.complete({ passphrase: TEST_PASSPHRASE });
  });

  test('@smoke J1/J2/J3 zero totals, then totals and charts follow added and edited transactions', async ({
    app,
    page,
  }) => {
    await expect(tile(page, 'balance')).toHaveText('€0.00');
    await expect(page.getByText('No expenses in this period.')).toBeVisible();

    const tx = new TransactionsPage(page);
    await tx.goto();
    await tx.addIncome({ amount: '3500', category: 'Salary', date: '2026-03-01', note: 'Salary' });
    await tx.addExpense({ amount: '1200', category: 'Housing', date: '2026-03-02', note: 'Rent' });
    await tx.addExpense({
      amount: '45.50',
      category: 'Food',
      date: '2026-03-10',
      note: 'Groceries',
    });
    await app.shell.navigate('Dashboard');

    await expect(tile(page, 'income')).toHaveText('€3,500.00');
    await expect(tile(page, 'expense')).toHaveText('€1,245.50');
    await expect(tile(page, 'balance')).toHaveText('€2,254.50');
    const byCategory = page.getByRole('table', { name: 'Expenses by category' });
    await expect(byCategory.getByRole('row').filter({ has: page.getByRole('cell') })).toHaveText([
      'Housing€1,200.00',
      'Food€45.50',
    ]);
    await expect(
      page.getByRole('img', { name: /Total income €3,500.00, total expenses €1,245.50/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Recent transactions' }).getByRole('link').first(),
    ).toContainText('Groceries');

    // J3: editing recalculates the totals.
    await tx.goto();
    await tx.open('Rent');
    await tx.form.fill({ amount: '1000', date: '2026-02-27' });
    await tx.form.submit();
    await app.shell.navigate('Dashboard');
    await expect(tile(page, 'expense')).toHaveText('€45.50');
    await page.getByLabel('Period').selectOption('last-month');
    await expect(tile(page, 'expense')).toHaveText('€1,000.00');
    await expect(tile(page, 'balance')).toHaveText('-€1,000.00');
  });

  test('@a11y the dashboard with charts has no serious axe violations', async ({ page }) => {
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const tx = new TransactionsPage(page);
    await tx.goto();
    await tx.addExpense({ amount: '20', category: 'Food', date: '2026-03-03', note: 'Lunch' });
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Dashboard' })
      .click();
    await expect(page.getByRole('table', { name: 'Expenses by category' })).toBeVisible();

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map(
            (v) =>
              `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary ?? ''}`).join(' | ')}`,
          ),
        scheme,
      ).toEqual([]);
    }
  });
});
