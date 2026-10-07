import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// SQLite schema (BUILD_PLAN §4.1). PostgreSQL mirrors it in Phase 5. `schema_migrations` is owned
// by the migrator and is not part of the Drizzle schema.

const kindCheck = (column: unknown) => sql`${column} in ('income', 'expense')`;

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['income', 'expense'] }).notNull(),
    color: text('color').notNull(),
    icon: text('icon').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    // Names are unique per kind among non-deleted rows (case-insensitive).
    uniqueIndex('categories_kind_name_active_uq')
      .on(t.kind, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`),
    check('categories_kind_ck', kindCheck(t.kind)),
  ],
);

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['income', 'expense'] }).notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    date: text('date').notNull(),
    note: text('note').notNull().default(''),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    index('transactions_date_idx').on(t.date),
    index('transactions_category_idx').on(t.categoryId),
    index('transactions_kind_date_idx').on(t.kind, t.date),
    index('transactions_deleted_idx').on(t.deletedAt),
    check('transactions_kind_ck', kindCheck(t.kind)),
    check(
      'transactions_amount_ck',
      sql`${t.amountMinor} > 0 and ${t.amountMinor} <= 10000000000000`,
    ),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
