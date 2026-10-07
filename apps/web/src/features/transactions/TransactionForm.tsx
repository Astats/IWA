import { SUPPORTED_CURRENCIES, type Kind } from '@budget/core';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { Field, NativeSelect } from '@/components/form/Field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useCategoriesByKind } from '@/hooks/useCategories';
import { useFormatters } from '@/hooks/useFormatters';
import { cn } from '@/lib/utils';

import { createTransactionFormSchema, type TransactionFormValues } from './transaction-form';

export function TransactionForm({
  initialValues,
  submitLabel,
  error,
  onSubmit,
  onCancel,
  extraActions,
}: {
  initialValues: TransactionFormValues;
  submitLabel: string;
  error?: string | null;
  onSubmit: (values: TransactionFormValues) => Promise<void>;
  onCancel: () => void;
  extraActions?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const schema = useMemo(() => createTransactionFormSchema(fmt.locale), [fmt.locale]);
  const { register, handleSubmit, formState, control, setValue, getValues } =
    useForm<TransactionFormValues>({
      resolver: zodResolver(schema),
      defaultValues: initialValues,
      mode: 'onTouched',
    });
  const kind = useWatch({ control, name: 'kind' });
  const currency = useWatch({ control, name: 'currency' });
  const categories = useCategoriesByKind(kind);
  const errors = formState.errors;

  const setKind = (next: Kind) => {
    setValue('kind', next, { shouldDirty: true });
    // A category of the other kind would be rejected; make the user pick again.
    const current = categories.find((c) => c.id === getValues('categoryId'));
    if (current && current.kind !== next) setValue('categoryId', '');
  };

  const amountError = errors.amount?.message
    ? t(`transactions.errors.${errors.amount.message}`, { defaultValue: t('validation.invalid') })
    : undefined;

  return (
    <form className="grid gap-4" noValidate onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{t('transactions.kind')}</legend>
        <div className="inline-flex rounded-lg border p-0.5">
          {(['expense', 'income'] as const).map((k) => (
            <label
              key={k}
              className={cn(
                'relative cursor-pointer rounded-md px-3 py-1 text-sm has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50',
                kind === k && 'bg-primary text-primary-foreground',
              )}
            >
              <input
                type="radio"
                name="kind"
                className="absolute inset-0 cursor-pointer appearance-none opacity-0"
                value={k}
                checked={kind === k}
                onChange={() => {
                  setKind(k);
                }}
              />
              {t(`common.${k}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <Field
          label={t('transactions.amount')}
          hint={t('transactions.amountHint', {
            example: fmt.money(123456, currency, { style: 'decimal' }),
          })}
          error={amountError}
        >
          {(c) => <Input {...c} inputMode="decimal" autoComplete="off" {...register('amount')} />}
        </Field>
        <Field label={t('transactions.currency')}>
          {(c) => (
            <NativeSelect {...c} {...register('currency')}>
              {SUPPORTED_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('transactions.category')}
          error={errors.categoryId ? t('transactions.errors.CATEGORY_REQUIRED') : undefined}
        >
          {(c) => (
            <NativeSelect {...c} {...register('categoryId')}>
              <option value="">{t('transactions.chooseCategory')}</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field
          label={t('transactions.date')}
          error={errors.date ? t('transactions.errors.DATE') : undefined}
        >
          {(c) => <Input {...c} type="date" {...register('date')} />}
        </Field>
      </div>
      <Field
        label={t('transactions.note')}
        hint={t('transactions.noteHint')}
        error={errors.note ? t('validation.tooLong') : undefined}
      >
        {(c) => <Textarea {...c} rows={2} maxLength={500} {...register('note')} />}
      </Field>
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={formState.isSubmitting}>
          {submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        {extraActions}
      </div>
    </form>
  );
}
