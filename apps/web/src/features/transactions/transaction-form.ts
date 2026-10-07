import {
  currencySchema,
  formatAmount,
  isoDateSchema,
  kindSchema,
  noteSchema,
  safeParseAmount,
  type NewTransaction,
  type Transaction,
} from '@budget/core';
import { z } from 'zod';

/**
 * Form values as typed by the user. `amount` stays a string until submit and is parsed with the
 * user's locale (`1 234,56` vs `1,234.56`) into integer minor units — never via floats (N7).
 */
export function createTransactionFormSchema(locale: string) {
  return z
    .object({
      kind: kindSchema,
      amount: z.string(),
      currency: currencySchema,
      categoryId: z.string().min(1, 'CATEGORY_REQUIRED'),
      date: isoDateSchema,
      note: noteSchema,
    })
    .superRefine((values, ctx) => {
      const parsed = safeParseAmount(values.amount, values.currency, locale);
      if (!parsed.ok)
        ctx.addIssue({ code: 'custom', path: ['amount'], message: `AMOUNT_${parsed.error}` });
    });
}

export type TransactionFormValues = z.infer<ReturnType<typeof createTransactionFormSchema>>;

/** Converts validated form values into repository input. */
export function toNewTransaction(values: TransactionFormValues, locale: string): NewTransaction {
  const parsed = safeParseAmount(values.amount, values.currency, locale);
  if (!parsed.ok) throw new Error('Amount must be validated before conversion');
  return {
    kind: values.kind,
    amountMinor: parsed.amountMinor,
    currency: values.currency,
    categoryId: values.categoryId,
    date: values.date,
    note: values.note,
  };
}

/** Initial form values for a new transaction or for editing an existing one. */
export function toFormValues(
  locale: string,
  defaults: { currency: string; date: string },
  transaction?: Transaction,
): TransactionFormValues {
  if (!transaction) {
    return {
      kind: 'expense',
      amount: '',
      currency: defaults.currency,
      categoryId: '',
      date: defaults.date,
      note: '',
    };
  }
  return {
    kind: transaction.kind,
    amount: formatAmount(transaction.amountMinor, transaction.currency, locale, {
      style: 'decimal',
    }),
    currency: transaction.currency,
    categoryId: transaction.categoryId,
    date: transaction.date,
    note: transaction.note,
  };
}
