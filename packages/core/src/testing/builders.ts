import { Faker, en } from '@faker-js/faker';

import {
  CATEGORY_ICONS,
  type Category,
  type Kind,
  type NewTransaction,
  type Transaction,
} from '../domain';
import type { KdfParams } from '../kdf';
import type { Repositories } from '../repositories';

/**
 * Seeded faker shared by the builders. Test files call `testFaker.seed(12345)` (TEST_PLAN §2.4) so
 * generated data is deterministic.
 */
export const testFaker = new Faker({ locale: [en] });
testFaker.seed(12345);

/** Fast Argon2id parameters for unit/component tests (TEST_PLAN §2.5). Never used in production. */
export const testKdfParams: KdfParams = {
  algorithm: 'argon2id',
  memoryKiB: 1024,
  iterations: 1,
  parallelism: 1,
};

const FIXED_TIMESTAMP = '2026-03-15T10:00:00.000Z';

export function aCategory(overrides: Partial<Category> = {}): Category {
  const kind: Kind = overrides.kind ?? testFaker.helpers.arrayElement(['income', 'expense']);
  return {
    id: testFaker.string.uuid(),
    name: testFaker.commerce.department().slice(0, 50),
    kind,
    color: testFaker.color.rgb({ format: 'hex', casing: 'lower' }),
    icon: testFaker.helpers.arrayElement(CATEGORY_ICONS),
    sortOrder: 0,
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    deletedAt: null,
    ...overrides,
  };
}

export function aTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: testFaker.string.uuid(),
    kind: 'expense',
    amountMinor: testFaker.number.int({ min: 1, max: 1_000_000 }),
    currency: 'EUR',
    categoryId: testFaker.string.uuid(),
    date: testFaker.date
      .between({ from: '2025-01-01T00:00:00Z', to: '2026-03-15T00:00:00Z' })
      .toISOString()
      .slice(0, 10),
    note: testFaker.lorem.words({ min: 0, max: 5 }),
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    deletedAt: null,
    ...overrides,
  };
}

export function aNewTransaction(
  overrides: Partial<NewTransaction> & Pick<NewTransaction, 'categoryId'>,
): NewTransaction {
  const t = aTransaction();
  return {
    kind: t.kind,
    amountMinor: t.amountMinor,
    currency: t.currency,
    date: t.date,
    note: t.note,
    ...overrides,
  };
}

export interface SeedLedgerOptions {
  count: number;
  seed?: number;
  dateRange?: { from: string; to: string };
  currencies?: string[];
}

/**
 * Inserts `count` random transactions spread over the existing (or default) categories.
 * Returns the inserted inputs so tests can compute expectations independently.
 */
export async function seedLedger(
  repos: Pick<Repositories, 'transactions' | 'categories'>,
  { count, seed = 12345, dateRange, currencies = ['EUR'] }: SeedLedgerOptions,
): Promise<NewTransaction[]> {
  const faker = new Faker({ locale: [en], seed });
  await repos.categories.seedDefaults();
  const categories = await repos.categories.list();
  const from = dateRange?.from ?? '2025-01-01';
  const to = dateRange?.to ?? '2026-03-15';
  const items: NewTransaction[] = Array.from({ length: count }, () => {
    const category = faker.helpers.arrayElement(categories);
    return {
      kind: category.kind,
      categoryId: category.id,
      amountMinor: faker.number.int({ min: 1, max: 500_000 }),
      currency: faker.helpers.arrayElement(currencies),
      date: faker.date
        .between({ from: `${from}T00:00:00Z`, to: `${to}T00:00:00Z` })
        .toISOString()
        .slice(0, 10),
      note: faker.lorem.words({ min: 0, max: 4 }),
    };
  });
  for (let i = 0; i < items.length; i += 1000) {
    await repos.transactions.bulkInsert(items.slice(i, i + 1000));
  }
  return items;
}
