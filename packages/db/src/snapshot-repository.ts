import {
  DomainError,
  MAX_CATEGORY_NAME_LENGTH,
  type Category,
  type LedgerSnapshot,
  type MergeResult,
  type Settings,
  type SettingsRepository,
  type SnapshotRepository,
  type Transaction,
} from '@budget/core';
import { asc, sql } from 'drizzle-orm';

import { inTransaction, type Db, type RepoContext } from './context';
import { categories, settings, transactions } from './schema';
import { settingsRows } from './settings-repository';

const CHUNK = 400;

function assertIntegrity(snapshot: LedgerSnapshot): void {
  const ids = new Set(snapshot.categories.map((c) => c.id));
  if (ids.size !== snapshot.categories.length)
    throw new DomainError('VALIDATION', 'Duplicate category id');
  const txIds = new Set(snapshot.transactions.map((t) => t.id));
  if (txIds.size !== snapshot.transactions.length)
    throw new DomainError('VALIDATION', 'Duplicate transaction id');
  for (const t of snapshot.transactions) {
    if (!ids.has(t.categoryId))
      throw new DomainError('VALIDATION', 'Transaction references an unknown category');
  }
}

async function insertCategories(db: Db, rows: readonly Category[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK)
    await db.insert(categories).values(rows.slice(i, i + CHUNK));
}

async function insertTransactions(db: Db, rows: readonly Transaction[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK)
    await db.insert(transactions).values(rows.slice(i, i + CHUNK));
}

async function writeSettings(db: Db, value: Settings): Promise<void> {
  for (const row of settingsRows(value)) {
    await db
      .insert(settings)
      .values(row)
      .onConflictDoUpdate({ target: settings.key, set: { value: row.value } });
  }
}

/** Picks a name that does not clash with another active category of the same kind. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = name.slice(0, MAX_CATEGORY_NAME_LENGTH - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export class SqliteSnapshotRepository implements SnapshotRepository {
  constructor(
    private readonly ctx: RepoContext,
    private readonly settingsRepo: SettingsRepository,
  ) {}

  async exportSnapshot(): Promise<LedgerSnapshot> {
    const [cats, txs, s] = [
      await this.ctx.db
        .select()
        .from(categories)
        .orderBy(asc(categories.kind), asc(categories.sortOrder), asc(categories.id)),
      await this.ctx.db
        .select()
        .from(transactions)
        .orderBy(asc(transactions.date), asc(transactions.id)),
      await this.settingsRepo.getAll(),
    ];
    return {
      categories: cats.map((c) => ({ ...c, icon: c.icon as Category['icon'] })),
      transactions: txs,
      settings: s,
    };
  }

  async replaceAll(snapshot: LedgerSnapshot): Promise<void> {
    assertIntegrity(snapshot);
    await inTransaction(this.ctx, async (db) => {
      await db.delete(transactions);
      await db.delete(categories);
      await insertCategories(db, snapshot.categories);
      await insertTransactions(db, snapshot.transactions);
      await writeSettings(db, snapshot.settings);
    });
  }

  async mergeAll(snapshot: LedgerSnapshot): Promise<MergeResult> {
    assertIntegrity(snapshot);
    return inTransaction(this.ctx, async (db) => {
      const result: MergeResult = {
        categories: { inserted: 0, updated: 0 },
        transactions: { inserted: 0, updated: 0 },
      };
      const localCats = new Map((await db.select().from(categories)).map((c) => [c.id, c]));
      const activeNames = (kind: string, exceptId: string) =>
        new Set(
          [...localCats.values()]
            .filter((c) => c.kind === kind && c.deletedAt === null && c.id !== exceptId)
            .map((c) => c.name.toLowerCase()),
        );

      for (const incoming of snapshot.categories) {
        const local = localCats.get(incoming.id);
        if (local && incoming.updatedAt <= local.updatedAt) continue;
        const row = {
          ...incoming,
          name:
            incoming.deletedAt === null
              ? uniqueName(incoming.name, activeNames(incoming.kind, incoming.id))
              : incoming.name,
        };
        if (local) {
          await db
            .update(categories)
            .set(row)
            .where(sql`${categories.id} = ${incoming.id}`);
          result.categories.updated++;
        } else {
          await db.insert(categories).values(row);
          result.categories.inserted++;
        }
        localCats.set(row.id, row);
      }

      const localTx = new Map(
        (
          await db
            .select({ id: transactions.id, updatedAt: transactions.updatedAt })
            .from(transactions)
        ).map((t) => [t.id, t.updatedAt]),
      );
      const inserts: Transaction[] = [];
      for (const incoming of snapshot.transactions) {
        const localUpdatedAt = localTx.get(incoming.id);
        if (localUpdatedAt === undefined) {
          inserts.push(incoming);
        } else if (incoming.updatedAt > localUpdatedAt) {
          // Newest updated_at wins, including tombstones (deleted_at set) over older edits.
          await db
            .update(transactions)
            .set(incoming)
            .where(sql`${transactions.id} = ${incoming.id}`);
          result.transactions.updated++;
        }
      }
      await insertTransactions(db, inserts);
      result.transactions.inserted = inserts.length;
      return result;
    });
  }
}
