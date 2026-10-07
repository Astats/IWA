import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { CategoryIcon } from '@/components/CategoryIcon';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { useCategoryMap } from '@/hooks/useCategories';
import { useFormatters } from '@/hooks/useFormatters';
import { useTransactionList } from '@/hooks/useTransactions';
import { cn } from '@/lib/utils';

/** Transaction list (Step 1.8 adds sorting, filtering and pagination). */
export function TransactionsPage() {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const categories = useCategoryMap();
  const { data } = useTransactionList({ sortBy: 'date', sortDir: 'desc', limit: 50 });

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
      {data && data.items.length === 0 && (
        <p className="text-muted-foreground">{t('transactions.empty')}</p>
      )}
      <ul className="grid gap-1" aria-label={t('transactions.title')}>
        {data?.items.map((tx) => {
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
                    tx.kind === 'income' ? 'text-emerald-700 dark:text-emerald-400' : '',
                  )}
                >
                  {fmt.money(tx.kind === 'income' ? tx.amountMinor : -tx.amountMinor, tx.currency)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
