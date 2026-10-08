import { describe, expect, it } from 'vitest';

import {
  assertCategoryMatches,
  categorySchema,
  dateRangeSchema,
  isValidIsoDate,
  newCategorySchema,
  newTransactionSchema,
  newTransactionWithCategorySchema,
  settingsSchema,
  transactionPatchSchema,
  transactionQuerySchema,
  transactionSchema,
} from './domain';
import { DomainError, isDomainError } from './errors';
import { aCategory, aTransaction, testFaker } from './testing';

testFaker.seed(12345);

const CAT_ID = '0192f0c1-7a3b-7c3d-8e4f-1a2b3c4d5e6f';

const validNewTx = {
  kind: 'expense',
  amountMinor: 1250,
  currency: 'EUR',
  categoryId: CAT_ID,
  date: '2026-03-15',
  note: 'Lunch',
} as const;

describe('isValidIsoDate', () => {
  it.each(['2026-01-01', '2024-02-29', '2000-02-29', '2026-12-31'])('accepts %s', (d) => {
    expect(isValidIsoDate(d)).toBe(true);
  });

  it.each([
    '2026-02-29',
    '1900-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-1-1',
    '26-01-01',
    '2026-01-01T00:00',
    '',
  ])('rejects %j', (d) => {
    expect(isValidIsoDate(d)).toBe(false);
  });
});

describe('newTransactionSchema', () => {
  it('accepts a valid transaction and strips unknown keys', () => {
    const parsed = newTransactionSchema.parse({ ...validNewTx, userId: 'x', __proto__x: 1 });

    expect(parsed).toEqual(validNewTx);
    expect(parsed).not.toHaveProperty('userId');
  });

  it('trims the note and defaults it to empty', () => {
    expect(newTransactionSchema.parse({ ...validNewTx, note: '  hi  ' }).note).toBe('hi');
    const { note: _note, ...withoutNote } = validNewTx;
    expect(newTransactionSchema.parse(withoutNote).note).toBe('');
  });

  it.each([
    ['kind', 'transfer'],
    ['amountMinor', 0],
    ['amountMinor', -5],
    ['amountMinor', 1.5],
    ['amountMinor', 10 ** 13 + 1],
    ['amountMinor', Number.NaN],
    ['amountMinor', '100'],
    ['currency', 'eur'],
    ['currency', 'EURO'],
    ['currency', 'XYZ'],
    ['categoryId', 'not-a-uuid'],
    ['date', '2026-02-30'],
    ['date', '15.03.2026'],
    ['note', 'x'.repeat(501)],
    ['id', 'abc'],
  ])('rejects %s = %j', (field, value) => {
    expect(newTransactionSchema.safeParse({ ...validNewTx, [field]: value }).success).toBe(false);
  });

  it('accepts boundary values', () => {
    expect(newTransactionSchema.safeParse({ ...validNewTx, amountMinor: 1 }).success).toBe(true);
    expect(newTransactionSchema.safeParse({ ...validNewTx, amountMinor: 10 ** 13 }).success).toBe(
      true,
    );
    expect(newTransactionSchema.safeParse({ ...validNewTx, note: 'x'.repeat(500) }).success).toBe(
      true,
    );
    expect(newTransactionSchema.safeParse({ ...validNewTx, kind: 'income' }).success).toBe(true);
  });

  it('accepts an optional client id', () => {
    expect(newTransactionSchema.parse({ ...validNewTx, id: CAT_ID }).id).toBe(CAT_ID);
  });
});

describe('transactionPatchSchema', () => {
  it('allows partial updates but still validates fields', () => {
    expect(transactionPatchSchema.parse({ amountMinor: 5 })).toEqual({ amountMinor: 5 });
    expect(transactionPatchSchema.safeParse({ amountMinor: 0 }).success).toBe(false);
    expect(transactionPatchSchema.parse({ id: CAT_ID })).toEqual({});
  });
});

describe('transactionSchema', () => {
  it('accepts a full row and rejects a bad timestamp', () => {
    const row = aTransaction();
    expect(transactionSchema.parse(row)).toEqual(row);
    expect(transactionSchema.safeParse({ ...row, updatedAt: 'yesterday' }).success).toBe(false);
    expect(
      transactionSchema.safeParse({ ...row, deletedAt: '2026-03-15T10:00:00.000Z' }).success,
    ).toBe(true);
  });
});

describe('categorySchema', () => {
  const validCat = { name: 'Food', kind: 'expense', color: '#ff8800', icon: 'utensils' } as const;

  it('accepts a valid category and trims the name', () => {
    expect(newCategorySchema.parse({ ...validCat, name: '  Food  ' }).name).toBe('Food');
    expect(categorySchema.parse(aCategory())).toBeTruthy();
  });

  it.each([
    ['name', ''],
    ['name', '   '],
    ['name', 'x'.repeat(51)],
    ['kind', 'both'],
    ['color', 'red'],
    ['color', '#fff'],
    ['color', '#gggggg'],
    ['icon', 'skull'],
    ['sortOrder', -1],
  ])('rejects %s = %j', (field, value) => {
    expect(newCategorySchema.safeParse({ ...validCat, [field]: value }).success).toBe(false);
  });

  it('accepts a 50-character name', () => {
    expect(newCategorySchema.safeParse({ ...validCat, name: 'x'.repeat(50) }).success).toBe(true);
  });
});

describe('category kind rules', () => {
  const category = aCategory({ id: CAT_ID, kind: 'income' });

  it('assertCategoryMatches rejects a kind mismatch', () => {
    expect(() => assertCategoryMatches({ kind: 'expense', categoryId: CAT_ID }, category)).toThrow(
      DomainError,
    );
    try {
      assertCategoryMatches({ kind: 'expense', categoryId: CAT_ID }, category);
    } catch (err) {
      expect(isDomainError(err, 'CATEGORY_KIND_MISMATCH')).toBe(true);
    }
  });

  it('assertCategoryMatches rejects missing or deleted categories', () => {
    expect(() => assertCategoryMatches({ kind: 'income', categoryId: CAT_ID }, null)).toThrow(
      'CATEGORY_NOT_FOUND',
    );
    expect(() =>
      assertCategoryMatches(
        { kind: 'income', categoryId: CAT_ID },
        { ...category, deletedAt: '2026-01-01T00:00:00.000Z' },
      ),
    ).toThrow('CATEGORY_NOT_FOUND');
  });

  it('assertCategoryMatches accepts a matching category', () => {
    expect(() =>
      assertCategoryMatches({ kind: 'income', categoryId: CAT_ID }, category),
    ).not.toThrow();
  });

  it('newTransactionWithCategorySchema reports mismatches on categoryId', () => {
    const schema = newTransactionWithCategorySchema(new Map([[CAT_ID, category]]));

    const mismatch = schema.safeParse(validNewTx);
    const unknown = schema.safeParse({
      ...validNewTx,
      kind: 'income',
      categoryId: '0192f0c1-7a3b-7c3d-8e4f-000000000000',
    });
    const ok = schema.safeParse({ ...validNewTx, kind: 'income' });

    expect(mismatch.error?.issues[0]).toMatchObject({
      path: ['categoryId'],
      message: 'CATEGORY_KIND_MISMATCH',
    });
    expect(unknown.error?.issues[0]).toMatchObject({
      path: ['categoryId'],
      message: 'CATEGORY_NOT_FOUND',
    });
    expect(ok.success).toBe(true);
  });
});

describe('settingsSchema', () => {
  const valid = {
    baseCurrency: 'EUR',
    locale: 'en',
    theme: 'dark',
    autoLockMinutes: 5,
    backupRetention: 3,
    backupFrequency: 'daily',
    lastBackupAt: '2026-03-01T10:00:00.000Z',
    schemaVersion: 1,
  };

  it('accepts valid settings', () => {
    expect(settingsSchema.parse(valid)).toEqual(valid);
  });

  it('defaults backup settings for settings written before they existed', () => {
    const { backupRetention: _r, backupFrequency: _f, lastBackupAt: _l, ...older } = valid;
    expect(settingsSchema.parse(older)).toMatchObject({
      backupRetention: 10,
      backupFrequency: 'weekly',
      lastBackupAt: null,
    });
  });

  it.each([
    ['baseCurrency', 'EU'],
    ['theme', 'blue'],
    ['autoLockMinutes', 0],
    ['autoLockMinutes', 121],
    ['backupRetention', 0],
    ['backupRetention', 101],
    ['backupRetention', 2.5],
    ['backupFrequency', 'hourly'],
    ['lastBackupAt', 'yesterday'],
    ['locale', ''],
  ])('rejects %s = %j', (field, value) => {
    expect(settingsSchema.safeParse({ ...valid, [field]: value }).success).toBe(false);
  });
});

describe('transactionQuerySchema', () => {
  it('applies defaults', () => {
    expect(transactionQuerySchema.parse({})).toEqual({
      sortBy: 'date',
      sortDir: 'desc',
      limit: 50,
      offset: 0,
    });
  });

  it.each([
    [{ limit: 501 }],
    [{ limit: 0 }],
    [{ offset: -1 }],
    [{ sortBy: 'note' }],
    [{ sortBy: 'date; DROP TABLE transactions' }],
    [{ sortDir: 'sideways' }],
    [{ dateFrom: '2026-03-02', dateTo: '2026-03-01' }],
    [{ categoryIds: ['x'] }],
  ])('rejects %j', (q) => {
    expect(transactionQuerySchema.safeParse(q).success).toBe(false);
  });

  it('accepts the maximum page size and trims the search', () => {
    expect(transactionQuerySchema.parse({ limit: 500, search: '  rent ' })).toMatchObject({
      limit: 500,
      search: 'rent',
    });
  });
});

describe('dateRangeSchema', () => {
  it('accepts an ordered range and rejects a reversed one', () => {
    expect(
      dateRangeSchema.safeParse({ dateFrom: '2026-01-01', dateTo: '2026-01-01' }).success,
    ).toBe(true);
    expect(
      dateRangeSchema.safeParse({ dateFrom: '2026-01-02', dateTo: '2026-01-01' }).success,
    ).toBe(false);
  });
});
