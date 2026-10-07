import { SORT_KEYS, toLocalIsoDate, type SortKey } from '@budget/core';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';

import { NativeSelect } from '@/components/form/Field';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { useServices } from '@/di';
import { useCategories, useCategoryMap } from '@/hooks/useCategories';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useTransactionList } from '@/hooks/useTransactions';

import { FilterBar } from './FilterBar';
import {
  DEFAULT_LIST_PARAMS,
  PAGE_SIZES,
  parseListParams,
  toSearchParams,
  toTransactionQuery,
  type ListParams,
} from './list-params';
import { TransactionCards } from './TransactionCards';
import { TransactionTable } from './TransactionTable';

export function TransactionsPage() {
  const { t } = useTranslation();
  const services = useServices();
  const [searchParams, setSearchParams] = useSearchParams();
  // List state lives in React state (updated synchronously by each event) and is mirrored to the
  // URL. Router navigation is async, so reading params back from the URL would lag behind quick
  // successive changes. The URL is adopted only when it changes from outside (load, back/forward).
  const urlKey = searchParams.toString();
  const [params, setParams] = useState<ListParams>(() => parseListParams(searchParams));
  const [syncedUrl, setSyncedUrl] = useState(urlKey);
  if (urlKey !== syncedUrl) {
    setSyncedUrl(urlKey);
    if (urlKey !== toSearchParams(params).toString()) setParams(parseListParams(searchParams));
  }
  // The free-text search stays in memory only; it never enters the URL (SEC-W04).
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const wide = useMediaQuery('(min-width: 48rem)');
  const { data: categoryList = [] } = useCategories();
  const categories = useCategoryMap();
  const today = toLocalIsoDate(services.now());
  const query = toTransactionQuery(params, debouncedSearch, today);
  const { data, isFetching } = useTransactionList(query);

  const write = (next: ListParams) => {
    setParams(next);
    setSearchParams(toSearchParams(next), { replace: true });
  };
  const update = (patch: Partial<ListParams>, keepPage = false) => {
    write({ ...params, ...patch, ...(keepPage ? {} : { page: 0 }) });
  };

  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : params.page * params.pageSize + 1;
  const to = Math.min(total, (params.page + 1) * params.pageSize);
  const lastPage = Math.max(0, Math.ceil(total / params.pageSize) - 1);

  return (
    <>
      <PageHeader
        title={t('transactions.title')}
        actions={
          <Button asChild>
            <Link to="/transactions/new">
              <Plus aria-hidden /> {t('transactions.new')}
            </Link>
          </Button>
        }
      />
      <FilterBar
        params={params}
        categories={categoryList}
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          // A new search term starts again at the first page.
          if (params.page !== 0) update({ page: 0 });
        }}
        onChange={(patch) => {
          update(patch);
        }}
        onReset={() => {
          setSearch('');
          write(DEFAULT_LIST_PARAMS);
        }}
      />
      {!wide && (
        <div className="mb-3 flex gap-2">
          <NativeSelect
            aria-label={t('transactions.sortBy')}
            value={params.sortBy}
            onChange={(e) => {
              update({ sortBy: e.target.value as SortKey });
            }}
          >
            {SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {t(`transactions.sortKeys.${key}`)}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label={t('transactions.sortDirection')}
            value={params.sortDir}
            onChange={(e) => {
              update({ sortDir: e.target.value === 'asc' ? 'asc' : 'desc' });
            }}
          >
            <option value="asc">{t('transactions.ascending')}</option>
            <option value="desc">{t('transactions.descending')}</option>
          </NativeSelect>
        </div>
      )}
      <p className="mb-2 text-sm text-muted-foreground" role="status" aria-busy={isFetching}>
        {t('transactions.results', { from, to, total })}
      </p>
      {data && data.items.length === 0 ? (
        <p className="text-muted-foreground">
          {total === 0 &&
          !query.search &&
          !params.kind &&
          params.categoryIds.length === 0 &&
          !params.preset
            ? t('transactions.empty')
            : t('transactions.noMatches')}
        </p>
      ) : wide ? (
        <TransactionTable
          rows={data?.items ?? []}
          categories={categories}
          params={params}
          onSort={(sortBy, sortDir) => {
            update({ sortBy, sortDir });
          }}
        />
      ) : (
        <TransactionCards rows={data?.items ?? []} categories={categories} />
      )}
      <nav
        aria-label={t('transactions.pagination')}
        className="mt-4 flex flex-wrap items-center gap-2"
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={params.page === 0}
          onClick={() => {
            update({ page: params.page - 1 }, true);
          }}
        >
          <ChevronLeft aria-hidden /> {t('transactions.previous')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={params.page >= lastPage}
          onClick={() => {
            update({ page: params.page + 1 }, true);
          }}
        >
          {t('transactions.next')} <ChevronRight aria-hidden />
        </Button>
        <NativeSelect
          className="w-auto"
          aria-label={t('transactions.pageSize')}
          value={params.pageSize}
          onChange={(e) => {
            update({ pageSize: Number(e.target.value) as ListParams['pageSize'] });
          }}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {t('transactions.perPage', { count: size })}
            </option>
          ))}
        </NativeSelect>
      </nav>
    </>
  );
}
