import {
  currencyExponent,
  lastMonths,
  presetRange,
  type CategoryTotal,
  type DatePreset,
  type DateRange,
  type PeriodTotals,
  type Repositories,
  type Transaction,
} from '@budget/core';

export const DASHBOARD_PRESETS = [
  'this-month',
  'last-month',
  'this-year',
  'last-12-months',
] as const satisfies readonly Exclude<DatePreset, 'custom'>[];
export type DashboardPreset = (typeof DASHBOARD_PRESETS)[number];

export interface MonthPoint {
  month: string;
  /** Exact totals in minor units (tooltips, table). */
  income: bigint;
  expense: bigint;
  /** Major units as numbers, for drawing only. */
  incomeValue: number;
  expenseValue: number;
}

export interface DashboardData {
  range: DateRange;
  currency: string;
  totals: PeriodTotals;
  expensesByCategory: CategoryTotal[];
  months: MonthPoint[];
  recent: Transaction[];
}

/** Minor units → major units as a float for chart geometry only (never for displayed values). */
export function toChartValue(minor: bigint, currency: string): number {
  return Number(minor) / 10 ** currencyExponent(currency);
}

export function monthPoint(month: string, totals: PeriodTotals, currency: string): MonthPoint {
  const entry = totals.byCurrency.find((c) => c.currency === currency);
  const income = entry?.income ?? 0n;
  const expense = entry?.expense ?? 0n;
  return {
    month,
    income,
    expense,
    incomeValue: toChartValue(income, currency),
    expenseValue: toChartValue(expense, currency),
  };
}

/**
 * Everything the dashboard shows. Charts use the base currency only (no FX conversion, §4.2);
 * the tiles show every currency separately.
 */
export async function loadDashboard(
  repos: Repositories,
  preset: DashboardPreset,
  today: string,
  baseCurrency: string,
): Promise<DashboardData> {
  const range = presetRange(preset, today);
  const buckets = lastMonths(today, 12);
  const [totals, byCategory, monthly, recent] = await Promise.all([
    repos.transactions.totals(range),
    repos.transactions.byCategory({ ...range, kind: 'expense' }),
    Promise.all(buckets.map((b) => repos.transactions.totals(b))),
    repos.transactions.list({ sortBy: 'date', sortDir: 'desc', limit: 5 }),
  ]);
  return {
    range,
    currency: baseCurrency,
    totals,
    expensesByCategory: byCategory.filter((c) => c.currency === baseCurrency),
    months: buckets.map((b, i) =>
      monthPoint(b.month, monthly[i] ?? { ...b, byCurrency: [] }, baseCurrency),
    ),
    recent: recent.items,
  };
}
