import type { Category, SortKey, Transaction } from '@budget/core';
import {
  createColumnHelper,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type SortingState,
  type Updater,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { CategoryIcon } from '@/components/CategoryIcon';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useFormatters } from '@/hooks/useFormatters';
import { cn } from '@/lib/utils';

import type { ListParams } from './list-params';

const features = tableFeatures({ rowSortingFeature });
const helper = createColumnHelper<typeof features, Transaction>();

/** Columns whose id matches a repository sort key are sortable (server-side; manualSorting). */
const SORTABLE = new Set<string>(['date', 'amount', 'category', 'kind']);

export function TransactionTable({
  rows,
  categories,
  params,
  onSort,
}: {
  rows: Transaction[];
  categories: Map<string, Category>;
  params: Pick<ListParams, 'sortBy' | 'sortDir'>;
  onSort: (sortBy: SortKey, sortDir: 'asc' | 'desc') => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor('date', {
          id: 'date',
          header: () => t('transactions.date'),
          cell: (info) => fmt.date(info.getValue()),
        }),
        helper.accessor('categoryId', {
          id: 'category',
          header: () => t('transactions.category'),
          cell: (info) => {
            const category = categories.get(info.getValue());
            return (
              <span className="flex items-center gap-2">
                {category && <CategoryIcon icon={category.icon} color={category.color} />}
                <span>{category?.name ?? '—'}</span>
              </span>
            );
          },
        }),
        helper.accessor('note', {
          id: 'note',
          enableSorting: false,
          header: () => t('transactions.note'),
          cell: (info) => (
            <Link
              className="underline-offset-4 hover:underline"
              to={`/transactions/${info.row.original.id}`}
            >
              {info.getValue() || t('transactions.noNote')}
            </Link>
          ),
        }),
        helper.accessor('kind', {
          id: 'kind',
          header: () => t('transactions.kind'),
          cell: (info) => t(`common.${info.getValue()}`),
        }),
        helper.accessor('amountMinor', {
          id: 'amount',
          header: () => t('transactions.amount'),
          cell: (info) => {
            const tx = info.row.original;
            return (
              <span
                className={cn(
                  'tabular-nums',
                  tx.kind === 'income' && 'text-emerald-700 dark:text-emerald-400',
                )}
              >
                {fmt.money(tx.kind === 'income' ? tx.amountMinor : -tx.amountMinor, tx.currency)}
              </span>
            );
          },
        }),
      ]),
    [t, fmt, categories],
  );

  const sorting = useMemo<SortingState>(
    () => [{ id: params.sortBy, desc: params.sortDir === 'desc' }],
    [params.sortBy, params.sortDir],
  );

  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: (row) => row.id,
    manualSorting: true,
    enableSortingRemoval: false,
    sortDescFirst: false,
    state: { sorting },
    onSortingChange: (updater: Updater<SortingState>) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater;
      const first = next[0];
      if (first && SORTABLE.has(first.id)) onSort(first.id as SortKey, first.desc ? 'desc' : 'asc');
    },
  });

  return (
    <Table aria-label={t('transactions.title')}>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => {
              const sorted = header.column.getIsSorted();
              const canSort = header.column.getCanSort();
              return (
                <TableHead
                  key={header.id}
                  className={header.column.id === 'amount' ? 'text-right' : undefined}
                  aria-sort={
                    sorted === 'asc'
                      ? 'ascending'
                      : sorted === 'desc'
                        ? 'descending'
                        : canSort
                          ? 'none'
                          : undefined
                  }
                >
                  {canSort ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-medium"
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      <table.FlexRender header={header} />
                      {sorted === 'asc' ? (
                        <ArrowUp aria-hidden className="size-3.5" />
                      ) : sorted === 'desc' ? (
                        <ArrowDown aria-hidden className="size-3.5" />
                      ) : (
                        <ArrowUpDown aria-hidden className="size-3.5 opacity-50" />
                      )}
                    </button>
                  ) : (
                    <table.FlexRender header={header} />
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id}>
            {row.getAllCells().map((cell) => (
              <TableCell
                key={cell.id}
                className={cell.column.id === 'amount' ? 'text-right' : undefined}
              >
                <table.FlexRender cell={cell} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
