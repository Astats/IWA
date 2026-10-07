import { toLocalIsoDate } from '@budget/core';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { PageHeader } from '@/components/layout/PageHeader';
import { useToast } from '@/components/toast/Toaster';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useServices } from '@/di';
import { useFormatters } from '@/hooks/useFormatters';
import { useErrorMessage, useRepoMutation } from '@/hooks/useRepoMutation';
import { useSettings } from '@/hooks/useSettings';
import { useTransaction } from '@/hooks/useTransactions';

import { toFormValues, toNewTransaction, type TransactionFormValues } from './transaction-form';
import { TransactionForm } from './TransactionForm';
import { useDeleteTransaction } from './useDeleteTransaction';

/** Create (`/transactions/new`) or edit (`/transactions/:id`) a transaction. */
export function TransactionEditorPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const services = useServices();
  const fmt = useFormatters();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { data: settings } = useSettings();
  const existing = useTransaction(id);
  const [error, setError] = useState<string | null>(null);
  const deleteTransaction = useDeleteTransaction();

  const save = useRepoMutation((r, values: TransactionFormValues) => {
    const input = toNewTransaction(values, fmt.locale);
    return id ? r.transactions.update(id, input) : r.transactions.create(input);
  });

  const isEdit = id !== undefined;
  const title = isEdit ? t('transactions.edit') : t('transactions.new');
  if (!settings || (isEdit && existing.isPending)) return <PageHeader title={title} />;
  if (isEdit && !existing.data) {
    return (
      <>
        <PageHeader title={title} />
        <p role="alert">{t('errors.NOT_FOUND')}</p>
      </>
    );
  }

  const initialValues = toFormValues(
    fmt.locale,
    { currency: settings.baseCurrency, date: toLocalIsoDate(services.now()) },
    existing.data ?? undefined,
  );

  return (
    <>
      <PageHeader title={title} />
      <Card className="max-w-2xl">
        <CardContent>
          <TransactionForm
            key={id ?? 'new'}
            initialValues={initialValues}
            submitLabel={t('common.save')}
            error={error}
            onCancel={() => void navigate('/transactions')}
            onSubmit={async (values) => {
              setError(null);
              try {
                await save.mutateAsync(values);
              } catch (err) {
                setError(errorMessage(err));
                return;
              }
              toast({ message: t('transactions.saved') });
              void navigate('/transactions');
            }}
            extraActions={
              isEdit && (
                <Button
                  type="button"
                  variant="destructive"
                  className="sm:ml-auto"
                  onClick={() => {
                    void deleteTransaction(id).then((ok) => {
                      if (ok) void navigate('/transactions');
                    });
                  }}
                >
                  <Trash2 aria-hidden /> {t('common.delete')}
                </Button>
              )
            }
          />
        </CardContent>
      </Card>
    </>
  );
}
