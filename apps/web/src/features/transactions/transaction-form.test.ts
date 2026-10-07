import { aTransaction } from '@budget/core/testing';
import { describe, expect, it } from 'vitest';

import {
  createTransactionFormSchema,
  toFormValues,
  toNewTransaction,
  type TransactionFormValues,
} from './transaction-form';

const CAT = '0192f0c1-7a3b-7c3d-8e4f-1a2b3c4d5e6f';
const valid: TransactionFormValues = {
  kind: 'expense',
  amount: '12.50',
  currency: 'EUR',
  categoryId: CAT,
  date: '2026-03-15',
  note: 'Lunch',
};

function issues(values: Partial<TransactionFormValues>, locale = 'en-US') {
  const r = createTransactionFormSchema(locale).safeParse({ ...valid, ...values });
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}:${i.message}`);
}

describe('transaction form schema', () => {
  it('accepts valid input', () => {
    expect(issues({})).toEqual([]);
  });

  it.each([
    [{ amount: '' }, 'amount:AMOUNT_EMPTY'],
    [{ amount: '0' }, 'amount:AMOUNT_ZERO'],
    [{ amount: '-5' }, 'amount:AMOUNT_NEGATIVE'],
    [{ amount: '1.234' }, 'amount:AMOUNT_TOO_MANY_DECIMALS'],
    [{ amount: '1e5' }, 'amount:AMOUNT_INVALID'],
    [{ amount: '100000000000.01' }, 'amount:AMOUNT_TOO_LARGE'],
    [{ amount: '1.5', currency: 'JPY' }, 'amount:AMOUNT_TOO_MANY_DECIMALS'],
    [{ categoryId: '' }, 'categoryId:CATEGORY_REQUIRED'],
    [{ date: '2026-02-30' }, 'date:Expected a valid date in YYYY-MM-DD format'],
  ])('rejects %j', (values, issue) => {
    expect(issues(values)).toContain(issue);
  });

  it('rejects a note longer than 500 characters and trims it', () => {
    expect(issues({ note: 'x'.repeat(501) })[0]).toMatch(/^note:/);
    expect(createTransactionFormSchema('en-US').parse({ ...valid, note: '  hi  ' }).note).toBe(
      'hi',
    );
  });

  it('parses amounts with the user locale', () => {
    expect(issues({ amount: '1.234,56' }, 'de-DE')).toEqual([]);
    expect(toNewTransaction({ ...valid, amount: '1.234,56' }, 'de-DE').amountMinor).toBe(123456);
    expect(toNewTransaction({ ...valid, amount: '1,234.56' }, 'en-US').amountMinor).toBe(123456);
    expect(
      toNewTransaction({ ...valid, amount: '1 500', currency: 'KWD' }, 'fr-FR').amountMinor,
    ).toBe(1500000);
  });

  it('refuses to convert unvalidated amounts', () => {
    expect(() => toNewTransaction({ ...valid, amount: 'abc' }, 'en-US')).toThrow();
  });
});

describe('toFormValues', () => {
  it('builds defaults for a new transaction', () => {
    expect(toFormValues('en-US', { currency: 'USD', date: '2026-03-15' })).toEqual({
      kind: 'expense',
      amount: '',
      currency: 'USD',
      categoryId: '',
      date: '2026-03-15',
      note: '',
    });
  });

  it('round-trips an existing transaction through the form in any locale', () => {
    for (const locale of ['en-US', 'de-DE', 'fr-FR', 'ja-JP']) {
      const tx = aTransaction({ amountMinor: 1234567, currency: 'EUR' });
      const values = toFormValues(locale, { currency: 'EUR', date: '2026-01-01' }, tx);

      expect(toNewTransaction(values, locale)).toMatchObject({
        amountMinor: 1234567,
        note: tx.note,
      });
    }
  });
});
