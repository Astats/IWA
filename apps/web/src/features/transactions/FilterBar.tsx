import { DATE_PRESETS, type Category } from '@budget/core';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Field, NativeSelect } from '@/components/form/Field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import type { ListParams } from './list-params';

export function FilterBar({
  params,
  categories,
  search,
  onSearchChange,
  onChange,
  onReset,
}: {
  params: ListParams;
  categories: Category[];
  search: string;
  onSearchChange: (value: string) => void;
  onChange: (patch: Partial<ListParams>) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const visibleCategories = categories.filter((c) => !params.kind || c.kind === params.kind);
  const toggleCategory = (id: string, checked: boolean) => {
    const next = checked ? [...params.categoryIds, id] : params.categoryIds.filter((x) => x !== id);
    onChange({ categoryIds: next });
  };

  return (
    <section
      aria-label={t('transactions.filters.title')}
      className="mb-4 grid gap-3 rounded-lg border p-3"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('transactions.filters.search')} hint={t('transactions.filters.searchHint')}>
          {(c) => (
            <Input
              {...c}
              type="search"
              autoComplete="off"
              value={search}
              onChange={(e) => {
                onSearchChange(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t('transactions.filters.kind')}>
          {(c) => (
            <NativeSelect
              {...c}
              value={params.kind ?? ''}
              onChange={(e) => {
                const kind =
                  e.target.value === '' ? null : (e.target.value as 'income' | 'expense');
                // Keep only categories that match the new kind.
                const allowed = new Set(
                  categories.filter((x) => !kind || x.kind === kind).map((x) => x.id),
                );
                onChange({ kind, categoryIds: params.categoryIds.filter((id) => allowed.has(id)) });
              }}
            >
              <option value="">{t('common.all')}</option>
              <option value="expense">{t('common.expense')}</option>
              <option value="income">{t('common.income')}</option>
            </NativeSelect>
          )}
        </Field>
        <Field label={t('transactions.filters.period')}>
          {(c) => (
            <NativeSelect
              {...c}
              value={params.preset ?? ''}
              onChange={(e) => {
                const preset =
                  e.target.value === '' ? null : (e.target.value as ListParams['preset']);
                onChange({ preset, dateFrom: null, dateTo: null });
              }}
            >
              <option value="">{t('transactions.filters.allTime')}</option>
              {DATE_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {t(`periods.${p}`)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        {params.preset === 'custom' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('transactions.filters.from')}>
              {(c) => (
                <Input
                  {...c}
                  type="date"
                  value={params.dateFrom ?? ''}
                  onChange={(e) => {
                    onChange({ dateFrom: e.target.value || null });
                  }}
                />
              )}
            </Field>
            <Field label={t('transactions.filters.to')}>
              {(c) => (
                <Input
                  {...c}
                  type="date"
                  value={params.dateTo ?? ''}
                  onChange={(e) => {
                    onChange({ dateTo: e.target.value || null });
                  }}
                />
              )}
            </Field>
          </div>
        )}
      </div>
      <details className="group">
        <summary className="cursor-pointer text-sm font-medium">
          {t('transactions.filters.categories', { count: params.categoryIds.length })}
        </summary>
        <fieldset className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          <legend className="sr-only">{t('transactions.filters.categoriesLegend')}</legend>
          {visibleCategories.map((c) => (
            <label key={c.id} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={params.categoryIds.includes(c.id)}
                onChange={(e) => {
                  toggleCategory(c.id, e.target.checked);
                }}
              />
              {c.name}
              {!params.kind && (
                <span className="text-xs text-muted-foreground">({t(`common.${c.kind}`)})</span>
              )}
            </label>
          ))}
        </fieldset>
      </details>
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={onReset}>
          <X aria-hidden /> {t('transactions.filters.reset')}
        </Button>
      </div>
    </section>
  );
}
