import {
  definedOnly,
  categoryPatchSchema,
  DEFAULT_CATEGORY_SEEDS,
  DomainError,
  idSchema,
  newCategorySchema,
  type Category,
  type CategoryListOptions,
  type CategoryPatch,
  type CategoryRepository,
  type Kind,
  type NewCategory,
} from '@budget/core';
import { and, asc, count, eq, isNotNull, isNull, max, ne, sql, type SQL } from 'drizzle-orm';

import { inTransaction, type Db, type RepoContext } from './context';
import { categories, transactions } from './schema';

type Row = typeof categories.$inferSelect;

function toCategory(row: Row): Category {
  return { ...row, icon: row.icon as Category['icon'] };
}

async function findActive(db: Db, id: string): Promise<Row | null> {
  const rows = await db
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), isNull(categories.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

async function activeTransactionCount(db: Db, categoryId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(transactions)
    .where(and(eq(transactions.categoryId, categoryId), isNull(transactions.deletedAt)));
  return rows[0]?.n ?? 0;
}

async function assertNameFree(db: Db, kind: Kind, name: string, exceptId?: string): Promise<void> {
  const conditions: SQL[] = [
    eq(categories.kind, kind),
    sql`lower(${categories.name}) = lower(${name})`,
    isNull(categories.deletedAt),
  ];
  if (exceptId) conditions.push(ne(categories.id, exceptId));
  const rows = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(...conditions))
    .limit(1);
  if (rows.length > 0) throw new DomainError('DUPLICATE_CATEGORY_NAME');
}

export class SqliteCategoryRepository implements CategoryRepository {
  constructor(private readonly ctx: RepoContext) {}

  async list(options: CategoryListOptions = {}): Promise<Category[]> {
    const conditions: SQL[] = [];
    if (!options.includeDeleted) conditions.push(isNull(categories.deletedAt));
    if (options.kind) conditions.push(eq(categories.kind, options.kind));
    const rows = await this.ctx.db
      .select()
      .from(categories)
      .where(and(...conditions))
      .orderBy(
        asc(categories.kind),
        asc(categories.sortOrder),
        asc(sql`${categories.name} COLLATE NOCASE`),
        asc(categories.id),
      );
    return rows.map(toCategory);
  }

  async get(id: string): Promise<Category | null> {
    const row = await findActive(this.ctx.db, id);
    return row ? toCategory(row) : null;
  }

  async create(input: NewCategory): Promise<Category> {
    const parsed = newCategorySchema.parse(input);
    return inTransaction(this.ctx, async (db) => {
      await assertNameFree(db, parsed.kind, parsed.name);
      let sortOrder = parsed.sortOrder;
      if (sortOrder === undefined) {
        const rows = await db
          .select({ m: max(categories.sortOrder) })
          .from(categories)
          .where(and(eq(categories.kind, parsed.kind), isNull(categories.deletedAt)));
        const current = rows[0]?.m;
        sortOrder = current === null || current === undefined ? 0 : current + 1;
      }
      const now = this.ctx.now();
      const row: Row = {
        id: this.ctx.newId(),
        name: parsed.name,
        kind: parsed.kind,
        color: parsed.color,
        icon: parsed.icon,
        sortOrder,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await db.insert(categories).values(row);
      return toCategory(row);
    });
  }

  async update(id: string, patch: CategoryPatch): Promise<Category> {
    const parsed = categoryPatchSchema.parse(patch);
    return inTransaction(this.ctx, async (db) => {
      const existing = await findActive(db, id);
      if (!existing) throw new DomainError('NOT_FOUND');
      const next: Row = { ...existing, ...definedOnly(parsed), updatedAt: this.ctx.now() };
      if (next.kind !== existing.kind && (await activeTransactionCount(db, id)) > 0) {
        // Changing the kind would break "category kind = transaction kind" for existing rows.
        throw new DomainError('CATEGORY_IN_USE');
      }
      if (next.kind !== existing.kind || next.name.toLowerCase() !== existing.name.toLowerCase()) {
        await assertNameFree(db, next.kind, next.name, id);
      }
      await db
        .update(categories)
        .set({
          name: next.name,
          kind: next.kind,
          color: next.color,
          icon: next.icon,
          sortOrder: next.sortOrder,
          updatedAt: next.updatedAt,
        })
        .where(eq(categories.id, id));
      return toCategory(next);
    });
  }

  async softDelete(id: string): Promise<void> {
    await inTransaction(this.ctx, async (db) => {
      if (!(await findActive(db, id))) throw new DomainError('NOT_FOUND');
      if ((await activeTransactionCount(db, id)) > 0) throw new DomainError('CATEGORY_IN_USE');
      const now = this.ctx.now();
      await db
        .update(categories)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(categories.id, id));
    });
  }

  async restore(id: string): Promise<void> {
    await inTransaction(this.ctx, async (db) => {
      const rows = await db
        .select()
        .from(categories)
        .where(and(eq(categories.id, id), isNotNull(categories.deletedAt)))
        .limit(1);
      const row = rows[0];
      if (!row) throw new DomainError('NOT_FOUND');
      await assertNameFree(db, row.kind, row.name, id);
      await db
        .update(categories)
        .set({ deletedAt: null, updatedAt: this.ctx.now() })
        .where(eq(categories.id, id));
    });
  }

  async reassignTransactions(fromId: string, toId: string): Promise<number> {
    idSchema.parse(fromId);
    idSchema.parse(toId);
    if (fromId === toId) return 0;
    return inTransaction(this.ctx, async (db) => {
      const [from, to] = [await findActive(db, fromId), await findActive(db, toId)];
      if (!from || !to) throw new DomainError('CATEGORY_NOT_FOUND');
      if (from.kind !== to.kind) throw new DomainError('CATEGORY_KIND_MISMATCH');
      const now = this.ctx.now();
      const moved = await activeTransactionCount(db, fromId);
      await db
        .update(transactions)
        .set({ categoryId: toId, updatedAt: now })
        .where(and(eq(transactions.categoryId, fromId), isNull(transactions.deletedAt)));
      return moved;
    });
  }

  async reorder(orderedIds: string[]): Promise<void> {
    await inTransaction(this.ctx, async (db) => {
      for (const [index, id] of orderedIds.entries()) {
        const row = await findActive(db, id);
        if (!row) throw new DomainError('NOT_FOUND');
        if (row.sortOrder !== index) {
          await db
            .update(categories)
            .set({ sortOrder: index, updatedAt: this.ctx.now() })
            .where(eq(categories.id, id));
        }
      }
    });
  }

  async countTransactions(id: string): Promise<number> {
    return activeTransactionCount(this.ctx.db, id);
  }

  async seedDefaults(): Promise<number> {
    return inTransaction(this.ctx, async (db) => {
      const rows = await db.select({ n: count() }).from(categories);
      if ((rows[0]?.n ?? 0) > 0) return 0;
      const now = this.ctx.now();
      await db.insert(categories).values(
        DEFAULT_CATEGORY_SEEDS.map((s) => ({
          id: this.ctx.newId(),
          ...s,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })),
      );
      return DEFAULT_CATEGORY_SEEDS.length;
    });
  }
}
