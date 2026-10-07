import type { NewTransaction, Repositories } from '@budget/core';
import { createInMemoryRepositories } from '@budget/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadDashboard, toChartValue } from './dashboard-data';

let repos: Repositories;
let fixture: NewTransaction[];

/** Expected values are computed here with plain BigInt sums, independent of the code under test. */
function expectedTotals(rows: NewTransaction[], from: string, to: string, currency: string) {
  const inRange = rows.filter((r) => r.date >= from && r.date <= to && r.currency === currency);
  const sum = (kind: string) =>
    inRange.filter((r) => r.kind === kind).reduce((s, r) => s + BigInt(r.amountMinor), 0n);
  return { income: sum('income'), expense: sum('expense') };
}

beforeEach(async () => {
  repos = createInMemoryRepositories();
  await repos.categories.seedDefaults();
  const cats = await repos.categories.list();
  const id = (name: string, kind: 'income' | 'expense') =>
    cats.find((c) => c.name === name && c.kind === kind)!.id;
  fixture = [
    {
      kind: 'income',
      amountMinor: 350000,
      currency: 'EUR',
      categoryId: id('Salary', 'income'),
      date: '2026-03-01',
      note: '',
    },
    {
      kind: 'expense',
      amountMinor: 120000,
      currency: 'EUR',
      categoryId: id('Housing', 'expense'),
      date: '2026-03-02',
      note: '',
    },
    {
      kind: 'expense',
      amountMinor: 4550,
      currency: 'EUR',
      categoryId: id('Food', 'expense'),
      date: '2026-03-10',
      note: '',
    },
    {
      kind: 'expense',
      amountMinor: 3125,
      currency: 'EUR',
      categoryId: id('Food', 'expense'),
      date: '2026-03-14',
      note: '',
    },
    {
      kind: 'expense',
      amountMinor: 999,
      currency: 'USD',
      categoryId: id('Food', 'expense'),
      date: '2026-03-11',
      note: '',
    },
    {
      kind: 'income',
      amountMinor: 340000,
      currency: 'EUR',
      categoryId: id('Salary', 'income'),
      date: '2026-02-01',
      note: '',
    },
    {
      kind: 'expense',
      amountMinor: 120000,
      currency: 'EUR',
      categoryId: id('Housing', 'expense'),
      date: '2026-02-02',
      note: '',
    },
    {
      kind: 'expense',
      amountMinor: 10 ** 13,
      currency: 'EUR',
      categoryId: id('Other', 'expense'),
      date: '2025-04-30',
      note: '',
    },
    {
      kind: 'expense',
      amountMinor: 777,
      currency: 'EUR',
      categoryId: id('Other', 'expense'),
      date: '2025-03-31',
      note: '',
    },
  ];
  await repos.transactions.bulkInsert(fixture);
  // A deleted row must not count anywhere.
  const deleted = await repos.transactions.create({ ...fixture[1]!, amountMinor: 55555 });
  await repos.transactions.softDelete(deleted.id);
});

describe('loadDashboard', () => {
  it('period totals match independently computed sums per currency', async () => {
    const data = await loadDashboard(repos, 'this-month', '2026-03-15', 'EUR');

    const eur = expectedTotals(fixture, '2026-03-01', '2026-03-31', 'EUR');
    const usd = expectedTotals(fixture, '2026-03-01', '2026-03-31', 'USD');
    expect(data.range).toEqual({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });
    expect(data.totals.byCurrency).toEqual([
      { currency: 'EUR', ...eur, balance: eur.income - eur.expense },
      { currency: 'USD', ...usd, balance: usd.income - usd.expense },
    ]);
    expect(eur).toEqual({ income: 350000n, expense: 127675n });
  });

  it('expenses by category are in the base currency, largest first', async () => {
    const data = await loadDashboard(repos, 'this-month', '2026-03-15', 'EUR');

    expect(data.expensesByCategory.map((c) => [c.categoryName, c.total, c.count])).toEqual([
      ['Housing', 120000n, 1],
      ['Food', 7675n, 2],
    ]);
  });

  it('builds 12 monthly points ending with the current month, with exact totals', async () => {
    const data = await loadDashboard(repos, 'this-month', '2026-03-15', 'EUR');

    expect(data.months).toHaveLength(12);
    expect(data.months[0]).toMatchObject({ month: '2025-04', expense: 10n ** 13n, income: 0n });
    expect(data.months.map((m) => m.month)).not.toContain('2025-03');
    for (const m of data.months) {
      const [y, mo] = m.month.split('-').map(Number) as [number, number];
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const expected = expectedTotals(
        fixture,
        `${m.month}-01`,
        `${m.month}-${String(last).padStart(2, '0')}`,
        'EUR',
      );
      expect({ income: m.income, expense: m.expense }).toEqual(expected);
    }
  });

  it('includes the five most recent transactions and supports other presets', async () => {
    const data = await loadDashboard(repos, 'last-12-months', '2026-03-15', 'EUR');

    expect(data.recent.map((r) => r.date)).toEqual([
      '2026-03-14',
      '2026-03-11',
      '2026-03-10',
      '2026-03-02',
      '2026-03-01',
    ]);
    expect(data.range).toEqual({ dateFrom: '2025-04-01', dateTo: '2026-03-31' });
  });
});

describe('toChartValue', () => {
  it('converts minor units for drawing', () => {
    expect(toChartValue(12345n, 'EUR')).toBe(123.45);
    expect(toChartValue(500n, 'JPY')).toBe(500);
    expect(toChartValue(1n, 'KWD')).toBe(0.001);
  });
});
