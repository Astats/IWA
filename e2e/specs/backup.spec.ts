import { readFileSync } from 'node:fs';

import type { Page } from '@playwright/test';

import { expect, test, TEST_PASSPHRASE } from '../fixtures/app.fixture';
import { AppShell } from '../pages/AppShell';
import { OnboardingPage } from '../pages/OnboardingPage';
import { TransactionsPage } from '../pages/TransactionsPage';

async function downloadBackup(page: Page): Promise<{ name: string; bytes: Buffer }> {
  await new AppShell(page).navigate('Backup');
  await page.getByLabel('Current passphrase').fill(TEST_PASSPHRASE);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download backup file' }).click(),
  ]);
  await expect(page.getByText('Backup downloaded.')).toBeVisible();
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

async function restore(
  page: Page,
  file: { name: string; bytes: Buffer },
  mode: 'Merge' | 'Replace',
) {
  await new AppShell(page).navigate('Backup');
  await page
    .getByLabel('Backup file')
    .setInputFiles({ name: file.name, mimeType: 'application/octet-stream', buffer: file.bytes });
  await page.getByLabel('Backup passphrase').fill(TEST_PASSPHRASE);
  await page.getByRole('radio', { name: new RegExp(`^${mode}`) }).check();
  await page.getByRole('button', { name: 'Open backup' }).click();
}

test.describe('J12 encrypted backup and restore', () => {
  test('@smoke download → restore into a fresh profile (replace) → identical data; merge keeps newer local edits', async ({
    onboardedApp: _app,
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    const tx = new TransactionsPage(page);
    await tx.goto();
    await tx.addIncome({ amount: '3500', category: 'Salary', date: '2026-03-01', note: 'Salary' });
    await tx.addExpense({ amount: '12.50', category: 'Food', date: '2026-03-02', note: 'Lunch' });
    await tx.addExpense({ amount: '1200', category: 'Housing', date: '2026-03-03', note: 'Rent' });
    const notes = await tx.notes();

    const backup = await downloadBackup(page);
    expect(backup.name).toMatch(/^budget-backup-\d{8}-\d{6}\.bgtb$/);
    expect(backup.bytes.subarray(0, 4).toString()).toBe('BGTB');
    expect(backup.bytes.includes(Buffer.from('Lunch'))).toBe(false);

    // Fresh device: onboard, then replace everything with the backup.
    const fresh = await browser.newContext();
    const page2 = await fresh.newPage();
    const onboarding = new OnboardingPage(page2);
    await onboarding.goto();
    await onboarding.complete({ passphrase: TEST_PASSPHRASE, currency: 'USD' });
    await restore(page2, backup, 'Replace');
    const confirm = page2.getByRole('group', { name: 'Confirm restore' });
    await expect(confirm).toContainText('3 transaction(s), 13 categories');
    await confirm.getByRole('button', { name: 'Replace all data' }).click();
    await expect(page2.getByText('Backup restored. Your data was replaced.')).toBeVisible({
      timeout: 30_000,
    });
    const tx2 = new TransactionsPage(page2);
    await tx2.goto();
    expect(await tx2.notes()).toEqual(notes);
    await new AppShell(page2).navigate('Settings');
    await expect(page2.getByLabel('Base currency')).toHaveValue('EUR'); // settings come from the backup
    await fresh.close();

    // Merge on the original device: newer local changes win over the older backup.
    await tx.goto();
    await tx.open('Lunch');
    await tx.form.fill({ note: 'Lunch (edited after backup)' });
    await tx.form.submit();
    await tx.open('Rent');
    await tx.form.delete.click();
    await expect(tx.toast('Transaction deleted.')).toBeVisible();
    await restore(page, backup, 'Merge');
    await page.getByRole('button', { name: 'Merge backup' }).click();
    await expect(page.getByText('Backup merged into your data.')).toBeVisible({ timeout: 30_000 });
    await tx.goto();
    expect((await tx.notes()).sort()).toEqual(['Lunch (edited after backup)', 'Salary']);
  });

  test('@security SEC-W09 a tampered backup is rejected and nothing changes', async ({
    onboardedApp: _app,
    page,
  }) => {
    const tx = new TransactionsPage(page);
    await tx.goto();
    await tx.addExpense({ amount: '5', category: 'Food', note: 'Keep me' });
    const backup = await downloadBackup(page);
    const tampered = Buffer.from(backup.bytes);
    tampered[tampered.length - 10] = (tampered[tampered.length - 10] ?? 0) ^ 0xff;

    await restore(page, { name: backup.name, bytes: tampered }, 'Replace');

    await expect(page.getByRole('alert')).toHaveText('Wrong passphrase, or the file is damaged.');
    await tx.goto();
    expect(await tx.notes()).toEqual(['Keep me']);
  });
});
