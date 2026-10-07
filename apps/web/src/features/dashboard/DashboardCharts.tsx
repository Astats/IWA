import type { CategoryTotal } from '@budget/core';
import { useTranslation } from 'react-i18next';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
  type TooltipValueType,
} from 'recharts';

/** Tooltip props as Recharts passes them to a custom content renderer. */
type ChartTooltipProps = TooltipContentProps<TooltipValueType, string | number>;

import { useFormatters } from '@/hooks/useFormatters';

import { toChartValue, type MonthPoint } from './dashboard-data';

/*
 * Charts (BUILD_PLAN 1.9). Loaded lazily so Recharts stays out of the initial bundle. Every chart
 * has a text alternative: an aria-label summary plus a data table (TEST_PLAN: chart a11y).
 * Mark specs: thin bars, 4px rounded data ends, 2px gaps, recessive grid, hover tooltips.
 */

const AXIS_TICK = { fill: 'var(--muted-foreground)', fontSize: 12 };
const GRID_STROKE = 'var(--border)';

function TooltipBox({
  title,
  lines,
}: {
  title: string;
  lines: Array<{ label: string; value: string; color?: string }>;
}) {
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1 font-medium">{title}</p>
      {lines.map((l) => (
        <p key={l.label} className="flex items-center gap-2">
          {l.color && (
            <span
              aria-hidden
              className="inline-block size-2 rounded-sm"
              style={{ backgroundColor: l.color }}
            />
          )}
          <span className="text-muted-foreground">{l.label}</span>
          <span className="ml-auto tabular-nums">{l.value}</span>
        </p>
      ))}
    </div>
  );
}

export function MonthlyChart({ months, currency }: { months: MonthPoint[]; currency: string }) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const totalIncome = months.reduce((s, m) => s + m.income, 0n);
  const totalExpense = months.reduce((s, m) => s + m.expense, 0n);
  const summary = t('dashboard.monthlySummary', {
    income: fmt.money(totalIncome, currency),
    expense: fmt.money(totalExpense, currency),
  });

  const renderTooltip = (props: ChartTooltipProps) => {
    const point = typeof props.label === 'string' ? byMonth.get(props.label) : undefined;
    if (!props.active || !point) return null;
    return (
      <TooltipBox
        title={fmt.month(point.month)}
        lines={[
          {
            label: t('common.income'),
            value: fmt.money(point.income, currency),
            color: 'var(--chart-income)',
          },
          {
            label: t('common.expense'),
            value: fmt.money(point.expense, currency),
            color: 'var(--chart-expense)',
          },
        ]}
      />
    );
  };

  return (
    <figure className="grid gap-2">
      <div role="img" aria-label={summary} className="h-64 w-full">
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 480, height: 256 }}
        >
          <BarChart
            data={months}
            barGap={2}
            barCategoryGap="20%"
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray="0" />
            <XAxis
              dataKey="month"
              tickFormatter={(m: string) => fmt.month(m)}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: GRID_STROKE }}
              interval="preserveStartEnd"
            />
            <YAxis
              tickFormatter={(v: number) => fmt.compact(v)}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={56}
            />
            <Tooltip content={renderTooltip} cursor={{ fill: 'var(--muted)' }} />
            <Legend
              iconType="square"
              formatter={(value: string) => (
                <span className="text-xs text-foreground">{value}</span>
              )}
            />
            <Bar
              dataKey="incomeValue"
              name={t('common.income')}
              fill="var(--chart-income)"
              radius={[4, 4, 0, 0]}
              maxBarSize={18}
            />
            <Bar
              dataKey="expenseValue"
              name={t('common.expense')}
              fill="var(--chart-expense)"
              radius={[4, 4, 0, 0]}
              maxBarSize={18}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">
          {t('dashboard.showTable')}
        </summary>
        <table className="mt-2 w-full text-sm" aria-label={t('dashboard.monthlyTitle')}>
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="py-1 font-medium">
                {t('dashboard.month')}
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                {t('common.income')}
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                {t('common.expense')}
              </th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month} className="border-t">
                <th scope="row" className="py-1 text-left font-normal">
                  {fmt.month(m.month)}
                </th>
                <td className="py-1 text-right tabular-nums">{fmt.money(m.income, currency)}</td>
                <td className="py-1 text-right tabular-nums">{fmt.money(m.expense, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

export function CategoryChart({ rows, currency }: { rows: CategoryTotal[]; currency: string }) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  // Top 8 categories; the rest fold into "Other categories" (never a generated extra color).
  const top = rows.slice(0, 8);
  const rest = rows.slice(8);
  const data = [
    ...top.map((r) => ({
      key: r.categoryId,
      name: r.categoryName,
      swatch: r.color,
      total: r.total,
    })),
    ...(rest.length > 0
      ? [
          {
            key: 'other',
            name: t('dashboard.otherCategories'),
            swatch: 'var(--muted-foreground)',
            total: rest.reduce((s, r) => s + r.total, 0n),
          },
        ]
      : []),
  ].map((d) => ({ ...d, value: toChartValue(d.total, currency) }));
  const byName = new Map(data.map((d) => [d.name, d]));
  const summary = t('dashboard.categorySummary', {
    list: data.map((d) => `${d.name} ${fmt.money(d.total, currency)}`).join(', '),
  });

  const renderTooltip = (props: ChartTooltipProps) => {
    const row = typeof props.label === 'string' ? byName.get(props.label) : undefined;
    if (!props.active || !row) return null;
    return (
      <TooltipBox
        title={row.name}
        lines={[{ label: t('common.expense'), value: fmt.money(row.total, currency) }]}
      />
    );
  };

  return (
    <figure className="grid gap-2">
      <div
        role="img"
        aria-label={summary}
        style={{ height: `${Math.max(2, data.length) * 34 + 16}px` }}
        className="w-full"
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 480, height: 256 }}
        >
          <BarChart
            data={data}
            layout="vertical"
            barCategoryGap={6}
            margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
          >
            <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
            <XAxis
              type="number"
              tickFormatter={(v: number) => fmt.compact(v)}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={110}
            />
            <Tooltip content={renderTooltip} cursor={{ fill: 'var(--muted)' }} />
            <Bar
              dataKey="value"
              fill="var(--chart-expense)"
              radius={[0, 4, 4, 0]}
              maxBarSize={20}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
      <table className="w-full text-sm" aria-label={t('dashboard.byCategoryTitle')}>
        <thead className="sr-only">
          <tr>
            <th scope="col">{t('transactions.category')}</th>
            <th scope="col">{t('common.expense')}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.key} className="border-t">
              <th scope="row" className="py-1 text-left font-normal">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block size-2.5 rounded-sm"
                    style={{ backgroundColor: d.swatch }}
                  />
                  {d.name}
                </span>
              </th>
              <td className="py-1 text-right tabular-nums">{fmt.money(d.total, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
