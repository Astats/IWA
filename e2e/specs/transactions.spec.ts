import { expect, test } from '../fixtures/app.fixture';
import { TransactionsPage } from '../pages/TransactionsPage';

test.describe('transactions CRUD', () => {
  test('@smoke J2 add income and expense → list shows both', async ({
    onboardedApp: _app,
    page,
  }) => {
    const tx = new TransactionsPage(page);
    await tx.goto();
    await expect(page.getByText('No transactions yet.')).toBeVisible();

    await tx.addIncome({
      amount: '2,500.00',
      category: 'Salary',
      date: '2026-03-01',
      note: 'March salary',
    });
    await expect(tx.toast('Transaction saved.')).toBeVisible();
    await tx.addExpense({
      amount: '42.10',
      category: 'Food',
      date: '2026-03-05',
      note: 'Groceries',
    });

    await expect(tx.rows()).toHaveCount(2);
    await expect(tx.row('Groceries')).toContainText('-€42.10');
    await expect(tx.row('March salary')).toContainText('€2,500.00');
    await expect(tx.rows().first()).toContainText('Groceries'); // newest date first
  });

  test('@smoke J3 edit amount, category and date', async ({ onboardedApp: _app, page }) => {
    const tx = new TransactionsPage(page);
    await tx.goto();
    await tx.addExpense({ amount: '10', category: 'Food', date: '2026-03-05', note: 'Lunch' });

    await tx.open('Lunch');
    await expect(tx.form.amount).toHaveValue('10.00');
    await tx.form.fill({ amount: '12.75', category: 'Entertainment', date: '2026-02-28' });
    await tx.form.submit();

    await expect(tx.row('Lunch')).toContainText('Entertainment');
    await expect(tx.row('Lunch')).toContainText('-€12.75');
    await expect(tx.row('Lunch')).toContainText('Feb 28, 2026');
  });

  test('@smoke J4 delete → undo restores → delete again → gone', async ({
    onboardedApp: _app,
    page,
  }) => {
    const tx = new TransactionsPage(page);
    await tx.goto();
    await tx.addExpense({ amount: '3.50', category: 'Food', note: 'Coffee' });

    await tx.open('Coffee');
    await tx.form.delete.click();
    await expect(tx.toast('Transaction deleted.')).toBeVisible();
    await expect(tx.row('Coffee')).toHaveCount(0);
    await tx.toast('Transaction deleted.').getByRole('button', { name: 'Undo' }).click();
    await expect(tx.row('Coffee')).toHaveCount(1);

    await tx.open('Coffee');
    await tx.form.delete.click();
    await expect(tx.toast('Transaction deleted.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Transactions', level: 1 })).toBeVisible();
    await expect(tx.row('Coffee')).toHaveCount(0);
    await page.reload();
    await page.getByLabel('Passphrase', { exact: true }).fill('tulip river quiet lamp 2026');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('heading', { name: 'Transactions', level: 1 })).toBeVisible();
    await expect(page.getByText('No transactions yet.')).toBeVisible();
  });

  test('validation messages are inline and translated', async ({ onboardedApp: _app, page }) => {
    const tx = new TransactionsPage(page);
    await tx.goto();
    await page.getByRole('link', { name: 'New transaction' }).click();

    await tx.form.amount.fill('-5');
    await tx.form.save.click();

    await expect(page.getByText(/Enter a positive amount/)).toBeVisible();
    await expect(page.getByText('Choose a category.')).toBeVisible();
    await expect(tx.form.amount).toBeFocused();
  });

  test('@security SEC-W01 XSS payloads in note and category name render as text', async ({
    onboardedApp: app,
    page,
  }) => {
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs++;
      void d.dismiss();
    });
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    await app.shell.navigate('Categories');
    await page.getByRole('button', { name: 'New expense category' }).click();
    await page
      .getByRole('form', { name: 'Create category' })
      .getByLabel('Name')
      .fill('<svg onload=alert(3)>');
    await page.getByRole('button', { name: 'Create category' }).click();
    const tx = new TransactionsPage(page);
    await tx.goto();

    await tx.addExpense({ amount: '1', category: '<svg onload=alert(3)>', note: payload });

    await expect(tx.row(payload)).toBeVisible();
    await expect(tx.row(payload)).toContainText('<svg onload=alert(3)>');
    expect(await page.locator('main img, main script, main svg[onload]').count()).toBe(0);
    expect(dialogs).toBe(0);
  });
});

test('@smoke J6 deleting a category in use is blocked until its transactions are reassigned', async ({
  onboardedApp: app,
  page,
}) => {
  const tx = new TransactionsPage(page);
  await tx.goto();
  await tx.addExpense({ amount: '20', category: 'Shopping', note: 'Shoes' });
  await app.shell.navigate('Categories');

  await page.getByRole('button', { name: 'Delete Shopping', exact: true }).click();
  const panel = page.getByRole('group', { name: 'Delete Shopping' });
  await expect(panel).toContainText('is used by 1 transaction');
  await panel.getByLabel('Move transactions to').selectOption({ label: 'Other' });
  await panel.getByRole('button', { name: 'Move transactions and delete' }).click();

  await expect(
    page.getByRole('status').filter({ hasText: 'Category "Shopping" deleted.' }),
  ).toBeVisible();
  await tx.goto();
  await expect(tx.row('Shoes')).toContainText('Other');
});
