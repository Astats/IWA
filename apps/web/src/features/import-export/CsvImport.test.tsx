import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { axe } from '@/test/axe';
import { createFakeServices } from '@/test/fake-services';
import { renderApp } from '@/test/render';

const HEADER = 'date,kind,amount,currency,category,note,id';

async function setup(csv: string, name = 'import.csv') {
  const services = createFakeServices();
  await services.vault.repos.categories.seedDefaults();
  const app = renderApp({ services, route: '/import-export' });
  const input = await screen.findByLabelText('CSV file');
  await app.user.upload(input, new File([csv], name, { type: 'text/csv' }));
  await app.user.click(screen.getByRole('button', { name: 'Preview' }));
  return { app, services };
}

const count = (key: string) => screen.getByTestId(`count-${key}`).textContent;

describe('CSV import', () => {
  it('previews counts, rows and errors, then imports the valid rows in one go', async () => {
    const csv = [
      HEADER,
      '2026-03-01,expense,12.50,EUR,Food,Lunch,',
      '2026-03-02,expense,-1,EUR,Food,negative,',
      '2026-03-03,income,100,EUR,Bonus,Bonus payment,',
      '2026-03-04,transfer,1,EUR,Food,bad kind,',
    ].join('\n');
    const { app, services } = await setup(csv);

    await screen.findByRole('region', { name: 'Import preview' });
    expect(count('valid')).toBe('2');
    expect(count('invalid')).toBe('2');
    expect(count('duplicates')).toBe('0');
    expect(count('newCategories')).toBe('1');
    const errors = screen.getByRole('list', { name: 'Rows with errors (2)' });
    expect(
      within(errors)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Row 3, amount: Amounts must be positive; use the kind column for expenses.',
      'Row 5, kind: Use income or expense.',
    ]);
    const table = screen.getByRole('table', { name: 'First 2 valid rows' });
    expect(within(table).getByRole('row', { name: /Bonus payment/ })).toHaveTextContent(
      'Unknown category',
    );
    expect(screen.getByRole('button', { name: 'Import 1 transaction(s)' })).toBeEnabled();

    await app.user.click(
      screen.getByRole('checkbox', { name: /Create missing categories: Bonus/ }),
    );
    await app.user.click(screen.getByRole('button', { name: 'Import 2 transaction(s)' }));

    expect(await screen.findByText('Imported 2 transaction(s).')).toBeInTheDocument();
    expect((await services.vault.repos.transactions.list({})).total).toBe(2);
    expect(
      (await services.vault.repos.categories.list({ kind: 'income' })).map((c) => c.name),
    ).toContain('Bonus');
    expect(services.vault.flush).toHaveBeenCalled();
  });

  it('detects duplicates and lets the user import them anyway', async () => {
    const services = createFakeServices();
    await services.vault.repos.categories.seedDefaults();
    const food = (await services.vault.repos.categories.list()).find((c) => c.name === 'Food')!;
    await services.vault.repos.transactions.create({
      kind: 'expense',
      amountMinor: 1250,
      currency: 'EUR',
      categoryId: food.id,
      date: '2026-03-01',
      note: 'Lunch',
    });
    const app = renderApp({ services, route: '/import-export' });
    await app.user.upload(
      await screen.findByLabelText('CSV file'),
      new File([`${HEADER}\n2026-03-01,expense,12.50,EUR,Food,Lunch,\n`], 'd.csv'),
    );
    await app.user.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByTestId('count-duplicates')).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: 'Import 0 transaction(s)' })).toBeDisabled();
    await app.user.click(screen.getByRole('checkbox', { name: /Skip duplicates/ }));
    await app.user.click(screen.getByRole('button', { name: 'Import 1 transaction(s)' }));

    expect(await screen.findByText('Imported 1 transaction(s).')).toBeInTheDocument();
    expect((await services.vault.repos.transactions.list({})).total).toBe(2);
  });

  it.each([
    ['', 'The file is empty.'],
    [`${HEADER}\n`, 'The file has a header but no rows.'],
    ['date,amount\n2026-03-01,1\n', 'Required columns are missing: kind, currency, category.'],
  ])('rejects a bad file with a clear message (%#)', async (csv, message) => {
    await setup(csv);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('offers the error list as a CSV download', async () => {
    const urls: Blob[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn((blob: Blob) => {
          urls.push(blob);
          return 'blob:test/1';
        }),
        revokeObjectURL: vi.fn(),
      }),
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { app } = await setup(
      `${HEADER}\n2026-02-30,expense,1,EUR,Food,x,\n2026-03-01,expense,1,EUR,Food,ok,\n`,
    );

    await app.user.click(await screen.findByRole('button', { name: 'Download errors as CSV' }));

    expect(await urls[0]?.text()).toBe(
      'row,field,message\r\n2,date,Use a date in YYYY-MM-DD format.\r\n',
    );
  });

  it('a failed commit imports nothing and says so', async () => {
    const { app, services } = await setup(`${HEADER}\n2026-03-01,expense,1,EUR,Food,x,\n`);
    services.vault.repos.transactions.bulkInsert = () => Promise.reject(new Error('disk full'));

    await app.user.click(await screen.findByRole('button', { name: 'Import 1 transaction(s)' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The import failed. Nothing was imported.',
    );
    expect(document.body).not.toHaveTextContent('disk full');
  });

  it('renders imported XSS payloads as text in the preview (SEC-W01)', async () => {
    const { app } = await setup(
      `${HEADER}\n2026-03-01,expense,1,EUR,Food,<img src=x onerror=alert(1)>,\n`,
    );

    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(app.container.querySelector('img')).toBeNull();
  });

  it('has no axe violations in the preview', async () => {
    const { app } = await setup(
      `${HEADER}\n2026-02-30,expense,1,EUR,Food,x,\n2026-03-01,expense,1,EUR,Food,ok,\n`,
    );
    await screen.findByRole('region', { name: 'Import preview' });

    await waitFor(async () => {
      expect(await axe(app.container)).toHaveNoViolations();
    });
  });
});
