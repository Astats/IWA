import {
  definedOnly,
  assertCategoryMatches,
  dateRangeSchema,
  DomainError,
  kindSchema,
  newTransactionSchema,
  transactionPatchSchema,
  transactionQuerySchema,
  type CategoryTotal,
  type DateRange,
  type ExportOptions,
  type Kind,
  type NewTransaction,
  type ParsedNewTransaction,
  type PeriodTotals,
  type SortKey,
  type Transaction,
  type TransactionPatch,
  type TransactionQuery,
  type TransactionRepository,
} from '@budget/core';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import { inTransaction, type Db, type RepoContext } from './context';
import { categories, transactions } from './schema';

/** Fixed allow-list of sort expressions; user input never reaches SQL text (BUILD_PLAN §4.3). */
const SORT_COLUMNS: Record<SortKey, SQLiteColumn | SQL> = {
  date: transactions.date,
  amount: transactions.amountMinor,
  category: sql`${categories.name} COLLATE NOCASE`,
  kind: transactions.kind,
};

const INSERT_CHUNK = 500;
const EXPORT_PAGE = 500;

type Row = typeof transactions.$inferSelect;

function toTransaction(row: Row): Transaction {
  return { ...row };
}

async function loadCategory(db: Db, id: string) {
  const rows = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
  return rows[0] ?? null;
}

export class SqliteTransactionRepository implements TransactionRepository {
  constructor(private readonly ctx: RepoContext) {}

  async list(q: TransactionQuery): Promise<{ items: Transaction[]; total: number }> {
    const query = transactionQuerySchema.parse(q);
    const conditions: SQL[] = [isNull(transactions.deletedAt)];
    if (query.kind) conditions.push(eq(transactions.kind, query.kind));
    if (query.categoryIds && query.categoryIds.length > 0) {
      conditions.push(inArray(transactions.categoryId, query.categoryIds));
    }
    if (query.dateFrom) conditions.push(gte(transactions.date, query.dateFrom));
    if (query.dateTo) conditions.push(lte(transactions.date, query.dateTo));
    if (query.search) {
      // Literal, case-insensitive substring match: instr() has no wildcard characters.
      conditions.push(sql`instr(lower(${transactions.note}), lower(${query.search})) > 0`);
    }
    const where = and(...conditions);
    const dir = query.sortDir === 'asc' ? asc : desc;

    const [items, totals] = await Promise.all([
      this.ctx.db
        .select({ t: transactions })
        .from(transactions)
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .where(where)
        .orderBy(dir(SORT_COLUMNS[query.sortBy]), dir(transactions.id))
        .limit(query.limit)
        .offset(query.offset),
      this.ctx.db.select({ n: count() }).from(transactions).where(where),
    ]);
    return { items: items.map((r) => toTransaction(r.t)), total: totals[0]?.n ?? 0 };
  }

  async get(id: string): Promise<Transaction | null> {
    const rows = await this.ctx.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)))
      .limit(1);
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  async create(input: NewTransaction): Promise<Transaction> {
    const parsed = newTransactionSchema.parse(input);
    return inTransaction(this.ctx, async (db) => {
      assertCategoryMatches(parsed, await loadCategory(db, parsed.categoryId));
      const row = this.#newRow(parsed);
      await this.#assertIdFree(db, [row.id]);
      await db.insert(transactions).values(row);
      return toTransaction(row);
    });
  }

  async update(id: string, patch: TransactionPatch): Promise<Transaction> {
    const parsedPatch = transactionPatchSchema.parse(patch);
    return inTransaction(this.ctx, async (db) => {
      const rows = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)))
        .limit(1);
      const existing = rows[0];
      if (!existing) throw new DomainError('NOT_FOUND');
      const merged = newTransactionSchema.parse({ ...existing, ...definedOnly(parsedPatch), id });
      assertCategoryMatches(merged, await loadCategory(db, merged.categoryId));
      const updated: Row = { ...existing, ...merged, id, updatedAt: this.ctx.now() };
      await db
        .update(transactions)
        .set({
          kind: updated.kind,
          amountMinor: updated.amountMinor,
          currency: updated.currency,
          categoryId: updated.categoryId,
          date: updated.date,
          note: updated.note,
          updatedAt: updated.updatedAt,
        })
        .where(eq(transactions.id, id));
      return toTransaction(updated);
    });
  }

  async softDelete(id: string): Promise<void> {
    const now = this.ctx.now();
    const result = await this.ctx.driver.exec(
      'UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      [now, now, id],
    );
    if (result.changes === 0) throw new DomainError('NOT_FOUND');
  }

  async restore(id: string): Promise<void> {
    await inTransaction(this.ctx, async (db) => {
      const rows = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.id, id), isNotNull(transactions.deletedAt)))
        .limit(1);
      const row = rows[0];
      if (!row) throw new DomainError('NOT_FOUND');
      assertCategoryMatches(row, await loadCategory(db, row.categoryId));
      await db
        .update(transactions)
        .set({ deletedAt: null, updatedAt: this.ctx.now() })
        .where(eq(transactions.id, id));
    });
  }

  async totals(range: DateRange): Promise<PeriodTotals> {
    const { dateFrom, dateTo } = dateRangeSchema.parse(range);
    // Integer sums per currency and kind; returned as text so values beyond 2^53 stay exact.
    const rows = await this.ctx.driver.query<{ currency: string; kind: Kind; total: string }>(
      `SELECT currency, kind, CAST(SUM(amount_minor) AS TEXT) AS total
         FROM transactions
        WHERE deleted_at IS NULL AND date >= ? AND date <= ?
        GROUP BY currency, kind
        ORDER BY currency`,
      [dateFrom, dateTo],
    );
    const byCurrency = new Map<string, { income: bigint; expense: bigint }>();
    for (const r of rows) {
      const entry = byCurrency.get(r.currency) ?? { income: 0n, expense: 0n };
      entry[r.kind] = BigInt(r.total);
      byCurrency.set(r.currency, entry);
    }
    return {
      dateFrom,
      dateTo,
      byCurrency: [...byCurrency.entries()].map(([currency, t]) => ({
        currency,
        income: t.income,
        expense: t.expense,
        balance: t.income - t.expense,
      })),
    };
  }

  async byCategory(range: DateRange & { kind: Kind }): Promise<CategoryTotal[]> {
    const { dateFrom, dateTo } = dateRangeSchema.parse(range);
    const kind = kindSchema.parse(range.kind);
    const rows = await this.ctx.driver.query<{
      categoryId: string;
      categoryName: string;
      color: string;
      currency: string;
      total: string;
      count: number | bigint;
    }>(
      `SELECT t.category_id AS categoryId, c.name AS categoryName, c.color AS color,
              t.currency AS currency, CAST(SUM(t.amount_minor) AS TEXT) AS total, COUNT(*) AS count
         FROM transactions t JOIN categories c ON c.id = t.category_id
        WHERE t.deleted_at IS NULL AND t.kind = ? AND t.date >= ? AND t.date <= ?
        GROUP BY t.category_id, t.currency
        ORDER BY t.currency, SUM(t.amount_minor) DESC, c.name`,
      [kind, dateFrom, dateTo],
    );
    return rows.map((r) => ({ ...r, total: BigInt(r.total), count: Number(r.count) }));
  }

  async bulkInsert(items: NewTransaction[]): Promise<number> {
    const parsed = items.map((item, index) => {
      const result = newTransactionSchema.safeParse(item);
      if (!result.success) throw new DomainError('VALIDATION', `Item ${index} is invalid`);
      return result.data;
    });
    if (parsed.length === 0) return 0;
    return inTransaction(this.ctx, async (db) => {
      const categoryIds = [...new Set(parsed.map((p) => p.categoryId))];
      const cats = new Map<string, typeof categories.$inferSelect>();
      for (let i = 0; i < categoryIds.length; i += INSERT_CHUNK) {
        const chunk = categoryIds.slice(i, i + INSERT_CHUNK);
        for (const c of await db.select().from(categories).where(inArray(categories.id, chunk))) {
          cats.set(c.id, c);
        }
      }
      for (const p of parsed) assertCategoryMatches(p, cats.get(p.categoryId));
      const rows = parsed.map((p) => this.#newRow(p));
      if (new Set(rows.map((r) => r.id)).size !== rows.length)
        throw new DomainError('DUPLICATE_ID');
      await this.#assertIdFree(
        db,
        rows.map((r) => r.id),
      );
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await db.insert(transactions).values(rows.slice(i, i + INSERT_CHUNK));
      }
      return rows.length;
    });
  }

  async *exportAll(options: ExportOptions = {}): AsyncIterable<Transaction> {
    const where = options.includeDeleted ? undefined : isNull(transactions.deletedAt);
    for (let offset = 0; ; offset += EXPORT_PAGE) {
      const page = await this.ctx.db
        .select()
        .from(transactions)
        .where(where)
        .orderBy(asc(transactions.date), asc(transactions.createdAt), asc(transactions.id))
        .limit(EXPORT_PAGE)
        .offset(offset);
      for (const row of page) yield toTransaction(row);
      if (page.length < EXPORT_PAGE) return;
    }
  }

  #newRow(p: ParsedNewTransaction): Row {
    const now = this.ctx.now();
    return {
      id: p.id ?? this.ctx.newId(),
      kind: p.kind,
      amountMinor: p.amountMinor,
      currency: p.currency,
      categoryId: p.categoryId,
      date: p.date,
      note: p.note,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
  }

  async #assertIdFree(db: Db, ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
      const taken = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(inArray(transactions.id, ids.slice(i, i + INSERT_CHUNK)))
        .limit(1);
      if (taken.length > 0) throw new DomainError('DUPLICATE_ID');
    }
  }
}
