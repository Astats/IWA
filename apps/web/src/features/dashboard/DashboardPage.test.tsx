import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { axe } from '@/test/axe';
import { createFakeServices } from '@/test/fake-services';
import { renderApp } from '@/test/render';

/** Tiles render zeros until data arrives; wait for the expected value. */
async function expectTile(id: string, text: string) {
  await vi.waitFor(() => {
    expect(screen.getByTestId(id)).toHaveTextContent(text);
  });
}

async function seeded() {
  const services = createFakeServices();
  const repos = services.vault.repos;
  await repos.categories.seedDefaults();
  const cats = await repos.categories.list();
  const id = (name: string) => cats.find((c) => c.name === name)!.id;
  await repos.transactions.bulkInsert([
    {
      kind: 'income',
      amountMinor: 350000,
      currency: 'EUR',
      categoryId: id('Salary'),
      date: '2026-03-01',
      note: 'Salary',
    },
    {
      kind: 'expense',
      amountMinor: 120000,
      currency: 'EUR',
      categoryId: id('Housing'),
      date: '2026-03-02',
      note: 'Rent',
    },
    {
      kind: 'expense',
      amountMinor: 4550,
      currency: 'EUR',
      categoryId: id('Food'),
      date: '2026-03-10',
      note: 'Groceries',
    },
    {
      kind: 'expense',
      amountMinor: 50000,
      currency: 'EUR',
      categoryId: id('Housing'),
      date: '2026-02-02',
      note: 'Repair',
    },
  ]);
  return services;
}

describe('DashboardPage', () => {
  it('shows income, expense and balance for the selected period', async () => {
    renderApp({ services: await seeded() });

    await expectTile('total-income-EUR', '€3,500.00');
    expect(screen.getByTestId('total-expense-EUR')).toHaveTextContent('€1,245.50');
    expect(screen.getByTestId('total-balance-EUR')).toHaveTextContent('€2,254.50');
  });

  it('recalculates when the period changes', async () => {
    const app = renderApp({ services: await seeded() });
    await expectTile('total-income-EUR', '€3,500.00');

    await app.user.selectOptions(screen.getByLabelText('Period'), 'last-month');

    await expectTile('total-income-EUR', '€0.00');
    expect(screen.getByTestId('total-expense-EUR')).toHaveTextContent('€500.00');
    expect(screen.getByTestId('total-balance-EUR')).toHaveTextContent('-€500.00');
  });

  it('shows separate totals per currency (no FX conversion)', async () => {
    const services = await seeded();
    const food = (await services.vault.repos.categories.list()).find((c) => c.name === 'Food')!;
    await services.vault.repos.transactions.create({
      kind: 'expense',
      amountMinor: 999,
      currency: 'USD',
      categoryId: food.id,
      date: '2026-03-05',
      note: '',
    });
    renderApp({ services });

    expect(await screen.findByTestId('total-expense-USD')).toHaveTextContent('$9.99');
    await expectTile('total-expense-EUR', '€1,245.50');
    expect(screen.getByTestId('total-expense-EUR')).toHaveTextContent('€1,245.50');
    expect(screen.getByText(/Charts show amounts in EUR only/)).toBeInTheDocument();
  });

  it('gives charts a text alternative (aria-label summary and data tables)', async () => {
    renderApp({ services: await seeded() });

    const categoryTable = await screen.findByRole('table', { name: 'Expenses by category' });
    expect(
      within(categoryTable)
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.textContent),
    ).toEqual(['Housing€1,200.00', 'Food€45.50']);
    expect(
      screen.getByRole('img', { name: /expenses by category: Housing €1,200.00, Food €45.50/ }),
    ).toBeInTheDocument();
    const monthly = screen.getByRole('table', { name: 'Income and expenses, last 12 months' });
    expect(within(monthly).getAllByRole('row')).toHaveLength(13);
    expect(within(monthly).getByRole('row', { name: /Mar 2026/ })).toHaveTextContent(
      '€3,500.00€1,245.50',
    );
    expect(
      screen.getByRole('img', { name: /Total income €3,500.00, total expenses €1,745.50/ }),
    ).toBeInTheDocument();
  });

  it('lists recent transactions and an empty state', async () => {
    renderApp({ services: await seeded() });

    const recent = await screen.findByRole('list', { name: 'Recent transactions' });
    expect((await within(recent).findAllByRole('link'))[0]).toHaveTextContent('Groceries');
  });

  it('shows zero totals and empty states for a new vault', async () => {
    renderApp();

    expect(await screen.findByTestId('total-balance-EUR')).toHaveTextContent('€0.00');
    expect(await screen.findByText('No expenses in this period.')).toBeInTheDocument();
    expect(screen.getByText('No transactions yet.')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const app = renderApp({ services: await seeded() });
    await screen.findByRole('table', { name: 'Expenses by category' });

    expect(await axe(app.container)).toHaveNoViolations();
  });
});
