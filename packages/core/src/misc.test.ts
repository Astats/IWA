import { describe, expect, it } from 'vitest';

import { categorySchema, newCategorySchema } from './domain';
import { DomainError, isDomainError } from './errors';
import { createMonotonicClock, newId } from './ids';
import { kdfParamsSchema, meetsMinimumKdf, PRODUCTION_KDF_PARAMS } from './kdf';
import { DEFAULT_CATEGORY_SEEDS } from './seeds';
import { aCategory, aNewTransaction, testKdfParams } from './testing';

describe('newId', () => {
  it('generates distinct UUID v7 values', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));

    expect(ids.size).toBe(1000);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('createMonotonicClock', () => {
  it('is strictly increasing even when the wall clock stands still or goes back', () => {
    const times = [1000, 1000, 1000, 500, 2000];
    const clock = createMonotonicClock(() => new Date(times.shift() ?? 0));

    const stamps = Array.from({ length: 5 }, () => clock());

    expect(stamps).toEqual([
      '1970-01-01T00:00:01.000Z',
      '1970-01-01T00:00:01.001Z',
      '1970-01-01T00:00:01.002Z',
      '1970-01-01T00:00:01.003Z',
      '1970-01-01T00:00:02.000Z',
    ]);
  });

  it('defaults to the real clock', () => {
    expect(createMonotonicClock()()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('DEFAULT_CATEGORY_SEEDS', () => {
  it('match BUILD_PLAN §4.2 and are valid categories', () => {
    const names = (kind: string) =>
      DEFAULT_CATEGORY_SEEDS.filter((s) => s.kind === kind).map((s) => s.name);

    expect(names('expense')).toEqual([
      'Housing',
      'Food',
      'Transport',
      'Utilities',
      'Health',
      'Entertainment',
      'Shopping',
      'Other',
    ]);
    expect(names('income')).toEqual(['Salary', 'Freelance', 'Gifts', 'Interest', 'Other']);
    for (const seed of DEFAULT_CATEGORY_SEEDS)
      expect(newCategorySchema.safeParse(seed).success).toBe(true);
  });
});

describe('KDF params', () => {
  it('production params are m=64 MiB, t=3, p=1 and pass the schema', () => {
    expect(PRODUCTION_KDF_PARAMS).toEqual({
      algorithm: 'argon2id',
      memoryKiB: 65536,
      iterations: 3,
      parallelism: 1,
    });
    expect(kdfParamsSchema.parse(PRODUCTION_KDF_PARAMS)).toEqual(PRODUCTION_KDF_PARAMS);
  });

  it('rejects absurd or unknown params', () => {
    expect(
      kdfParamsSchema.safeParse({ ...PRODUCTION_KDF_PARAMS, memoryKiB: 2 ** 31 }).success,
    ).toBe(false);
    expect(
      kdfParamsSchema.safeParse({ ...PRODUCTION_KDF_PARAMS, algorithm: 'pbkdf2' }).success,
    ).toBe(false);
    expect(kdfParamsSchema.safeParse({ ...PRODUCTION_KDF_PARAMS, extra: 1 }).success).toBe(false);
  });

  it('detects downgrades below a minimum', () => {
    expect(meetsMinimumKdf(PRODUCTION_KDF_PARAMS, PRODUCTION_KDF_PARAMS)).toBe(true);
    expect(meetsMinimumKdf(testKdfParams, PRODUCTION_KDF_PARAMS)).toBe(false);
    expect(
      meetsMinimumKdf({ ...PRODUCTION_KDF_PARAMS, iterations: 2 }, PRODUCTION_KDF_PARAMS),
    ).toBe(false);
    expect(
      meetsMinimumKdf({ ...PRODUCTION_KDF_PARAMS, parallelism: 2 }, PRODUCTION_KDF_PARAMS),
    ).toBe(true);
  });
});

describe('DomainError', () => {
  it('carries a code and is detectable', () => {
    const err = new DomainError('CATEGORY_IN_USE');

    expect(err.message).toBe('CATEGORY_IN_USE');
    expect(isDomainError(err)).toBe(true);
    expect(isDomainError(err, 'NOT_FOUND')).toBe(false);
    expect(isDomainError(new Error('x'))).toBe(false);
  });
});

describe('builders', () => {
  it('produce schema-valid data', () => {
    expect(categorySchema.safeParse(aCategory()).success).toBe(true);
    const cat = aCategory({ kind: 'income' });
    expect(aNewTransaction({ categoryId: cat.id, kind: 'income' })).toMatchObject({
      categoryId: cat.id,
      kind: 'income',
    });
  });
});
