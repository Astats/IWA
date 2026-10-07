import { toLocalIsoDate } from '@budget/core';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { NativeSelect } from '@/components/form/Field';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useRepositories, useServices } from '@/di';
import { useCategoryMap } from '@/hooks/useCategories';
import { useFormatters } from '@/hooks/useFormatters';
import { queryKeys } from '@/hooks/useRepoMutation';
import { useSettings } from '@/hooks/useSettings';
import { cn } from '@/lib/utils';

import { DASHBOARD_PRESETS, loadDashboard, type DashboardPreset } from './dashboard-data';
import { TransactionCards } from '../transactions/TransactionCards';

const MonthlyChart = lazy(() =>
  import('./DashboardCharts').then((m) => ({ default: m.MonthlyChart })),
);
const CategoryChart = lazy(() =>
  import('./DashboardCharts').then((m) => ({ default: m.CategoryChart })),
);

function ChartFallback() {
  const { t } = useTranslation();
  return <p className="h-64 text-sm text-muted-foreground">{t('app.loading')}</p>;
}

export function DashboardPage() {
  const { t } = useTranslation();
  const repos = useRepositories();
  const services = useServices();
  const fmt = useFormatters();
  const categories = useCategoryMap();
  const { data: settings } = useSettings();
  const [preset, setPreset] = useState<DashboardPreset>('this-month');
  const today = toLocalIsoDate(services.now());
  const baseCurrency = settings?.baseCurrency ?? 'EUR';
  const { data } = useQuery({
    queryKey: [...queryKeys.dashboard, preset, today, baseCurrency],
    queryFn: () => loadDashboard(repos, preset, today, baseCurrency),
    enabled: !!settings,
  });

  const tiles = data?.totals.byCurrency.length
    ? data.totals.byCurrency
    : [{ currency: baseCurrency, income: 0n, expense: 0n, balance: 0n }];

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        actions={
          <>
            <NativeSelect
              aria-label={t('dashboard.period')}
              className="w-auto"
              value={preset}
              onChange={(e) => {
                setPreset(e.target.value as DashboardPreset);
              }}
            >
              {DASHBOARD_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {t(`periods.${p}`)}
                </option>
              ))}
            </NativeSelect>
            <Button asChild>
              <Link to="/transactions/new">
                <Plus aria-hidden /> {t('transactions.new')}
              </Link>
            </Button>
          </>
        }
      />
      {data && (
        <p className="mb-3 text-sm text-muted-foreground">
          {fmt.date(data.range.dateFrom)} – {fmt.date(data.range.dateTo)}
        </p>
      )}
      <section aria-label={t('dashboard.totals')} className="mb-4 grid gap-3">
        {tiles.map((c) => (
          <div key={c.currency} className="grid gap-3 sm:grid-cols-3">
            {(['income', 'expense', 'balance'] as const).map((field) => (
              <Card key={field} size="sm">
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    {t(`dashboard.${field}`)}
                    {tiles.length > 1 && ` · ${c.currency}`}
                  </p>
                  <p
                    className={cn(
                      'text-2xl font-semibold tabular-nums',
                      field === 'balance' && c.balance < 0n && 'text-destructive',
                    )}
                    data-testid={`total-${field}-${c.currency}`}
                  >
                    {fmt.money(c[field], c.currency)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        ))}
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t('dashboard.byCategoryTitle')}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.expensesByCategory.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('dashboard.noExpenses')}</p>
            ) : (
              data && (
                <Suspense fallback={<ChartFallback />}>
                  <CategoryChart rows={data.expensesByCategory} currency={data.currency} />
                </Suspense>
              )
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t('dashboard.monthlyTitle')}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && (
              <Suspense fallback={<ChartFallback />}>
                <MonthlyChart months={data.months} currency={data.currency} />
              </Suspense>
            )}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>
              <h2>{t('dashboard.recent')}</h2>
            </CardTitle>
            <Link className="text-sm underline-offset-4 hover:underline" to="/transactions">
              {t('dashboard.viewAll')}
            </Link>
          </CardHeader>
          <CardContent>
            {data && data.recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('transactions.empty')}</p>
            ) : (
              <TransactionCards
                rows={data?.recent ?? []}
                categories={categories}
                label={t('dashboard.recent')}
              />
            )}
          </CardContent>
        </Card>
      </div>
      {data && data.totals.byCurrency.some((c) => c.currency !== data.currency) && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t('dashboard.chartsCurrencyNote', { currency: data.currency })}
        </p>
      )}
    </>
  );
}
