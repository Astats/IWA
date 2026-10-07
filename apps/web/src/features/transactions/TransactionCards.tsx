import type { Category, Transaction } from '@budget/core';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { CategoryIcon } from '@/components/CategoryIcon';
import { useFormatters } from '@/hooks/useFormatters';
import { cn } from '@/lib/utils';

/** Card list for small screens (BUILD_PLAN 1.8). */
export function TransactionCards({
  rows,
  categories,
  label,
}: {
  rows: Transaction[];
  categories: Map<string, Category>;
  label?: string;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  return (
    <ul className="grid gap-1" aria-label={label ?? t('transactions.title')}>
      {rows.map((tx) => {
        const category = categories.get(tx.categoryId);
        return (
          <li key={tx.id}>
            <Link
              to={`/transactions/${tx.id}`}
              className="flex items-center gap-3 rounded-md border p-2 hover:bg-muted"
            >
              {category && <CategoryIcon icon={category.icon} color={category.color} />}
              <span className="grid min-w-0 flex-1">
                <span className="truncate font-medium">{category?.name ?? '—'}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {fmt.date(tx.date)}
                  {tx.note && ` · ${tx.note}`}
                </span>
              </span>
              <span
                className={cn(
                  'font-medium tabular-nums',
                  tx.kind === 'income' && 'text-emerald-700 dark:text-emerald-400',
                )}
              >
                {fmt.money(tx.kind === 'income' ? tx.amountMinor : -tx.amountMinor, tx.currency)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
