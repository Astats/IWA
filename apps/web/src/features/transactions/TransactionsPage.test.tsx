import type { NewTransaction } from '@budget/core';
import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { axe } from '@/test/axe';
import { createFakeServices } from '@/test/fake-services';
import { renderApp } from '@/test/render';

/** jsdom has no layout: choose the desktop table or the mobile cards explicitly. */
function setViewport(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: wide && query.includes('min-width'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

async function seeded() {
  const services = createFakeServices();
  const repos = services.vault.repos;
  await repos.categories.seedDefaults();
  const cats = await repos.categories.list();
  const id = (name: string) => cats.find((c) => c.name === name)!.id;
  const rows: NewTransaction[] = [
    {
      kind: 'expense',
      amountMinor: 500,
      currency: 'EUR',
      categoryId: id('Food'),
      date: '2026-03-02',
      note: 'Bakery',
    },
    {
      kind: 'expense',
      amountMinor: 120000,
      currency: 'EUR',
      categoryId: id('Housing'),
      date: '2026-03-01',
      note: 'Rent March',
    },
    {
      kind: 'income',
      amountMinor: 300000,
      currency: 'EUR',
      categoryId: id('Salary'),
      date: '2026-02-28',
      note: 'Salary Feb',
    },
    {
      kind: 'expense',
      amountMinor: 2500,
      currency: 'EUR',
      categoryId: id('Transport'),
      date: '2026-02-10',
      note: 'Train',
    },
    {
      kind: 'expense',
      amountMinor: 120000,
      currency: 'EUR',
      categoryId: id('Housing'),
      date: '2026-02-01',
      note: 'Rent Feb',
    },
  ];
  for (const r of rows) await repos.transactions.create(r);
  return { services, id };
}

const noteOrder = () =>
  within(screen.getByRole('table', { name: 'Transactions' }))
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getByRole('link').textContent);

afterEach(() => {
  vi.useRealTimers();
});

describe('TransactionsPage (desktop table)', () => {
  it('sorts by each sortable column in both directions (server-side) with aria-sort', async () => {
    setViewport(true);
    const { services } = await seeded();
    const app = renderApp({ services, route: '/transactions' });
    // First render of the full table is slow under v8 coverage; allow more than the 1 s default.
    await screen.findByRole('link', { name: 'Bakery' }, { timeout: 5000 });

    expect(noteOrder()).toEqual(['Bakery', 'Rent March', 'Salary Feb', 'Train', 'Rent Feb']);
    expect(screen.getByRole('columnheader', { name: /Date/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );

    await app.user.click(screen.getByRole('button', { name: 'Amount' }));
    expect(app.router.state.location.search).toBe('?sort=amount&dir=asc');
    expect(await screen.findByRole('columnheader', { name: /Amount/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    expect(noteOrder()[0]).toBe('Bakery');

    await app.user.click(screen.getByRole('button', { name: 'Amount' }));
    await vi.waitFor(() => {
      expect(noteOrder()[0]).toBe('Salary Feb');
    });

    await app.user.click(screen.getByRole('button', { name: 'Category' }));
    await vi.waitFor(() => {
      expect(noteOrder()[0]).toBe('Bakery'); // Food < Housing < Salary < Transport
    });
    await app.user.click(screen.getByRole('button', { name: 'Type' }));
    await vi.waitFor(() => {
      expect(noteOrder().at(-1)).toBe('Salary Feb'); // expense < income
    });
  });

  it('filters by kind, category and period, and the filters live in the URL', async () => {
    setViewport(true);
    const { services, id } = await seeded();
    const app = renderApp({ services, route: '/transactions' });
    await screen.findByRole('link', { name: 'Bakery' });

    await app.user.selectOptions(screen.getByLabelText('Type'), 'income');
    await vi.waitFor(() => {
      expect(noteOrder()).toEqual(['Salary Feb']);
    });

    await app.user.selectOptions(screen.getByLabelText('Type'), 'expense');
    await app.user.click(screen.getByText(/Categories \(0 selected\)/));
    await app.user.click(screen.getByRole('checkbox', { name: 'Housing' }));
    await vi.waitFor(() => {
      expect(noteOrder()).toEqual(['Rent March', 'Rent Feb']);
    });
    expect(app.router.state.location.search).toBe(`?kind=expense&cat=${id('Housing')}`);

    await app.user.selectOptions(screen.getByLabelText('Period'), 'this-month');
    await vi.waitFor(() => {
      expect(noteOrder()).toEqual(['Rent March']);
    });

    await app.user.selectOptions(screen.getByLabelText('Period'), 'custom');
    await app.user.type(screen.getByLabelText('From'), '2026-02-01');
    await app.user.type(screen.getByLabelText('To'), '2026-02-15');
    await vi.waitFor(() => {
      expect(noteOrder()).toEqual(['Rent Feb']);
    });

    await app.user.click(screen.getByRole('button', { name: 'Reset filters' }));
    await vi.waitFor(() => {
      expect(noteOrder()).toHaveLength(5);
    });
    expect(app.router.state.location.search).toBe('');
  });

  it('restores filters from the URL', async () => {
    setViewport(true);
    const { services } = await seeded();
    renderApp({ services, route: '/transactions?kind=income&sort=amount&dir=asc' });

    expect(await screen.findByRole('link', { name: 'Salary Feb' })).toBeInTheDocument();
    expect(screen.getByLabelText('Type')).toHaveValue('income');
    expect(noteOrder()).toEqual(['Salary Feb']);
  });

  it('searches notes after a 300 ms debounce and never puts the term in the URL (SEC-W04)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setViewport(true);
    const { services } = await seeded();
    const app = renderApp({
      services,
      route: '/transactions',
      advanceTimers: vi.advanceTimersByTime,
    });
    await screen.findByRole('link', { name: 'Bakery' });

    await app.user.type(screen.getByLabelText('Search notes'), 'rent');
    expect(noteOrder()).toHaveLength(5);
    await act(() => vi.advanceTimersByTimeAsync(350));

    await vi.waitFor(() => {
      expect(noteOrder()).toEqual(['Rent March', 'Rent Feb']);
    });
    expect(app.router.state.location.search).not.toContain('rent');
    expect(app.router.state.location.search).toBe('');
  });

  it('paginates', async () => {
    setViewport(true);
    const { services, id } = await seeded();
    await services.vault.repos.transactions.bulkInsert(
      Array.from({ length: 30 }, (_, i) => ({
        kind: 'expense' as const,
        amountMinor: 100 + i,
        currency: 'EUR',
        categoryId: id('Other'),
        date: '2025-01-01',
        note: `Old ${i}`,
      })),
    );
    const app = renderApp({ services, route: '/transactions?size=25' });
    await screen.findByRole('link', { name: 'Bakery' });

    expect(screen.getByText('1–25 of 35')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await app.user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('26–35 of 35')).toBeInTheDocument();
    expect(app.router.state.location.search).toBe('?page=1&size=25');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await app.user.selectOptions(screen.getByLabelText('Rows per page'), '50');
    expect(await screen.findByText('1–35 of 35')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    setViewport(true);
    const { services } = await seeded();
    const app = renderApp({ services, route: '/transactions' });
    await screen.findByRole('link', { name: 'Bakery' });

    expect(await axe(app.container)).toHaveNoViolations();
  });
});

describe('TransactionsPage (small screens)', () => {
  it('shows a card list with sort controls', async () => {
    setViewport(false);
    const { services } = await seeded();
    const app = renderApp({ services, route: '/transactions' });

    const list = await screen.findByRole('list', { name: 'Transactions' });
    expect(await within(list).findAllByRole('listitem')).toHaveLength(5);
    expect(screen.queryByRole('table')).toBeNull();

    await app.user.selectOptions(screen.getByLabelText('Sort by'), 'amount');
    await app.user.selectOptions(screen.getByLabelText('Sort direction'), 'asc');

    await vi.waitFor(() => {
      expect(
        within(screen.getByRole('list', { name: 'Transactions' })).getAllByRole('link')[0],
      ).toHaveTextContent('Bakery');
    });
    expect(app.router.state.location.search).toBe('?sort=amount&dir=asc');
  });

  it('shows an empty state', async () => {
    setViewport(false);
    renderApp({ route: '/transactions' });

    expect(await screen.findByText('No transactions yet.')).toBeInTheDocument();
  });
});
