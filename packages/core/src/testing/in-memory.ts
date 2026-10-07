import {
  assertCategoryMatches,
  categoryPatchSchema,
  dateRangeSchema,
  DEFAULT_SETTINGS,
  kindSchema,
  MAX_CATEGORY_NAME_LENGTH,
  newCategorySchema,
  newTransactionSchema,
  settingsSchema,
  transactionPatchSchema,
  transactionQuerySchema,
  type Category,
  type CategoryPatch,
  type DateRange,
  type Kind,
  type NewCategory,
  type NewTransaction,
  type Settings,
  type Transaction,
  type TransactionPatch,
  type TransactionQuery,
} from '../domain';
import { DomainError } from '../errors';
import { createMonotonicClock, newId } from '../ids';
import { definedOnly } from '../objects';
import type {
  CategoryListOptions,
  CategoryRepository,
  CategoryTotal,
  ExportOptions,
  LedgerSnapshot,
  MergeResult,
  PeriodTotals,
  Repositories,
  SettingsRepository,
  SnapshotRepository,
  TransactionRepository,
} from '../repositories';
import { DEFAULT_CATEGORY_SEEDS } from '../seeds';

/*
 * In-memory repository fakes for component tests (TEST_PLAN §4.6). They pass the same repository
 * contract suite as the SQLite implementation (packages/db/test/contract).
 */

interface Store {
  categories: Map<string, Category>;
  transactions: Map<string, Transaction>;
  settings: Partial<Settings>;
  now: () => string;
  newId: () => string;
}

/** SQLite `lower()` folds ASCII only; mirror that so both backends match identically. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

function activeCategory(store: Store, id: string): Category | null {
  const c = store.categories.get(id);
  return c && c.deletedAt === null ? c : null;
}

function activeTxCount(store: Store, categoryId: string): number {
  let n = 0;
  for (const t of store.transactions.values())
    if (t.categoryId === categoryId && t.deletedAt === null) n++;
  return n;
}

function assertNameFree(store: Store, kind: Kind, name: string, exceptId?: string): void {
  for (const c of store.categories.values()) {
    if (
      c.deletedAt === null &&
      c.kind === kind &&
      c.id !== exceptId &&
      asciiLower(c.name) === asciiLower(name)
    ) {
      throw new DomainError('DUPLICATE_CATEGORY_NAME');
    }
  }
}

export class InMemoryTransactionRepository implements TransactionRepository {
  constructor(private readonly store: Store) {}

  list(q: TransactionQuery): Promise<{ items: Transaction[]; total: number }> {
    // Async so validation errors surface as rejections, like the SQLite implementation.
    return Promise.resolve().then(() => this.#listSync(q));
  }

  #listSync(q: TransactionQuery): { items: Transaction[]; total: number } {
    const query = transactionQuerySchema.parse(q);
    const search = query.search ? asciiLower(query.search) : undefined;
    const rows = [...this.store.transactions.values()].filter(
      (t) =>
        t.deletedAt === null &&
        (!query.kind || t.kind === query.kind) &&
        (!query.categoryIds?.length || query.categoryIds.includes(t.categoryId)) &&
        (!query.dateFrom || t.date >= query.dateFrom) &&
        (!query.dateTo || t.date <= query.dateTo) &&
        (search === undefined || asciiLower(t.note).includes(search)),
    );
    const key = (t: Transaction): string | number => {
      switch (query.sortBy) {
        case 'date':
          return t.date;
        case 'amount':
          return t.amountMinor;
        case 'kind':
          return t.kind;
        case 'category':
          return asciiLower(this.store.categories.get(t.categoryId)?.name ?? '');
      }
    };
    const sign = query.sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => sign * (cmp(key(a), key(b)) || cmp(a.id, b.id)));
    return {
      items: rows.slice(query.offset, query.offset + query.limit).map((t) => ({ ...t })),
      total: rows.length,
    };
  }

  get(id: string): Promise<Transaction | null> {
    const t = this.store.transactions.get(id);
    return Promise.resolve(t && t.deletedAt === null ? { ...t } : null);
  }

  create(input: NewTransaction): Promise<Transaction> {
    return Promise.resolve().then(() => {
      const p = newTransactionSchema.parse(input);
      assertCategoryMatches(p, this.store.categories.get(p.categoryId));
      const id = p.id ?? this.store.newId();
      if (this.store.transactions.has(id)) throw new DomainError('DUPLICATE_ID');
      const now = this.store.now();
      const row: Transaction = { ...p, id, createdAt: now, updatedAt: now, deletedAt: null };
      this.store.transactions.set(id, row);
      return { ...row };
    });
  }

  update(id: string, patch: TransactionPatch): Promise<Transaction> {
    return Promise.resolve().then(() => {
      const parsed = transactionPatchSchema.parse(patch);
      const existing = this.store.transactions.get(id);
      if (!existing || existing.deletedAt !== null) throw new DomainError('NOT_FOUND');
      const merged = newTransactionSchema.parse({ ...existing, ...definedOnly(parsed), id });
      assertCategoryMatches(merged, this.store.categories.get(merged.categoryId));
      const row: Transaction = { ...existing, ...merged, id, updatedAt: this.store.now() };
      this.store.transactions.set(id, row);
      return { ...row };
    });
  }

  softDelete(id: string): Promise<void> {
    return Promise.resolve().then(() => {
      const t = this.store.transactions.get(id);
      if (!t || t.deletedAt !== null) throw new DomainError('NOT_FOUND');
      const now = this.store.now();
      this.store.transactions.set(id, { ...t, deletedAt: now, updatedAt: now });
    });
  }

  restore(id: string): Promise<void> {
    return Promise.resolve().then(() => {
      const t = this.store.transactions.get(id);
      if (!t || t.deletedAt === null) throw new DomainError('NOT_FOUND');
      assertCategoryMatches(t, this.store.categories.get(t.categoryId));
      this.store.transactions.set(id, { ...t, deletedAt: null, updatedAt: this.store.now() });
    });
  }

  totals(range: DateRange): Promise<PeriodTotals> {
    // Async so validation errors surface as rejections, like the SQLite implementation.
    return Promise.resolve().then(() => this.#totalsSync(range));
  }

  #totalsSync(range: DateRange): PeriodTotals {
    const { dateFrom, dateTo } = dateRangeSchema.parse(range);
    const map = new Map<string, { income: bigint; expense: bigint }>();
    for (const t of this.store.transactions.values()) {
      if (t.deletedAt !== null || t.date < dateFrom || t.date > dateTo) continue;
      const e = map.get(t.currency) ?? { income: 0n, expense: 0n };
      e[t.kind] += BigInt(t.amountMinor);
      map.set(t.currency, e);
    }
    return {
      dateFrom,
      dateTo,
      byCurrency: [...map.entries()]
        .sort(([a], [b]) => cmp(a, b))
        .map(([currency, e]) => ({ currency, ...e, balance: e.income - e.expense })),
    };
  }

  byCategory(range: DateRange & { kind: Kind }): Promise<CategoryTotal[]> {
    // Async so validation errors surface as rejections, like the SQLite implementation.
    return Promise.resolve().then(() => this.#byCategorySync(range));
  }

  #byCategorySync(range: DateRange & { kind: Kind }): CategoryTotal[] {
    const { dateFrom, dateTo } = dateRangeSchema.parse(range);
    const kind = kindSchema.parse(range.kind);
    const map = new Map<string, CategoryTotal>();
    for (const t of this.store.transactions.values()) {
      if (t.deletedAt !== null || t.kind !== kind || t.date < dateFrom || t.date > dateTo) continue;
      const c = this.store.categories.get(t.categoryId);
      if (!c) continue;
      const k = `${t.categoryId}|${t.currency}`;
      const e = map.get(k) ?? {
        categoryId: c.id,
        categoryName: c.name,
        color: c.color,
        currency: t.currency,
        total: 0n,
        count: 0,
      };
      e.total += BigInt(t.amountMinor);
      e.count++;
      map.set(k, e);
    }
    return [...map.values()].sort(
      (a, b) =>
        cmp(a.currency, b.currency) ||
        (a.total > b.total ? -1 : a.total < b.total ? 1 : 0) ||
        cmp(a.categoryName, b.categoryName),
    );
  }

  bulkInsert(items: NewTransaction[]): Promise<number> {
    return Promise.resolve().then(() => {
      const parsed = items.map((item, index) => {
        const r = newTransactionSchema.safeParse(item);
        if (!r.success) throw new DomainError('VALIDATION', `Item ${index} is invalid`);
        return r.data;
      });
      for (const p of parsed) assertCategoryMatches(p, this.store.categories.get(p.categoryId));
      const now = this.store.now;
      const rows = parsed.map((p) => {
        const ts = now();
        return {
          ...p,
          id: p.id ?? this.store.newId(),
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
        };
      });
      const ids = new Set(rows.map((r) => r.id));
      if (ids.size !== rows.length || rows.some((r) => this.store.transactions.has(r.id))) {
        throw new DomainError('DUPLICATE_ID');
      }
      for (const r of rows) this.store.transactions.set(r.id, r);
      return rows.length;
    });
  }

  async *exportAll(options: ExportOptions = {}): AsyncIterable<Transaction> {
    const rows = [...this.store.transactions.values()]
      .filter((t) => options.includeDeleted || t.deletedAt === null)
      .sort((a, b) => cmp(a.date, b.date) || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
    for (const r of rows) {
      await Promise.resolve();
      yield { ...r };
    }
  }
}

export class InMemoryCategoryRepository implements CategoryRepository {
  constructor(private readonly store: Store) {}

  list(options: CategoryListOptions = {}): Promise<Category[]> {
    const rows = [...this.store.categories.values()]
      .filter(
        (c) =>
          (options.includeDeleted || c.deletedAt === null) &&
          (!options.kind || c.kind === options.kind),
      )
      .sort(
        (a, b) =>
          cmp(a.kind, b.kind) ||
          cmp(a.sortOrder, b.sortOrder) ||
          cmp(asciiLower(a.name), asciiLower(b.name)) ||
          cmp(a.id, b.id),
      );
    return Promise.resolve(rows.map((c) => ({ ...c })));
  }

  get(id: string): Promise<Category | null> {
    const c = activeCategory(this.store, id);
    return Promise.resolve(c ? { ...c } : null);
  }

  create(input: NewCategory): Promise<Category> {
    return Promise.resolve().then(() => {
      const p = newCategorySchema.parse(input);
      assertNameFree(this.store, p.kind, p.name);
      const sameKind = [...this.store.categories.values()].filter(
        (c) => c.kind === p.kind && c.deletedAt === null,
      );
      const sortOrder =
        p.sortOrder ?? (sameKind.length ? Math.max(...sameKind.map((c) => c.sortOrder)) + 1 : 0);
      const now = this.store.now();
      const row: Category = {
        id: this.store.newId(),
        name: p.name,
        kind: p.kind,
        color: p.color,
        icon: p.icon,
        sortOrder,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.store.categories.set(row.id, row);
      return { ...row };
    });
  }

  update(id: string, patch: CategoryPatch): Promise<Category> {
    return Promise.resolve().then(() => {
      const p = categoryPatchSchema.parse(patch);
      const existing = activeCategory(this.store, id);
      if (!existing) throw new DomainError('NOT_FOUND');
      const next: Category = { ...existing, ...definedOnly(p), updatedAt: this.store.now() };
      if (next.kind !== existing.kind && activeTxCount(this.store, id) > 0) {
        throw new DomainError('CATEGORY_IN_USE');
      }
      if (next.kind !== existing.kind || asciiLower(next.name) !== asciiLower(existing.name)) {
        assertNameFree(this.store, next.kind, next.name, id);
      }
      this.store.categories.set(id, next);
      return { ...next };
    });
  }

  softDelete(id: string): Promise<void> {
    return Promise.resolve().then(() => {
      const c = activeCategory(this.store, id);
      if (!c) throw new DomainError('NOT_FOUND');
      if (activeTxCount(this.store, id) > 0) throw new DomainError('CATEGORY_IN_USE');
      const now = this.store.now();
      this.store.categories.set(id, { ...c, deletedAt: now, updatedAt: now });
    });
  }

  restore(id: string): Promise<void> {
    return Promise.resolve().then(() => {
      const c = this.store.categories.get(id);
      if (!c || c.deletedAt === null) throw new DomainError('NOT_FOUND');
      assertNameFree(this.store, c.kind, c.name, id);
      this.store.categories.set(id, { ...c, deletedAt: null, updatedAt: this.store.now() });
    });
  }

  reassignTransactions(fromId: string, toId: string): Promise<number> {
    return Promise.resolve().then(() => {
      if (fromId === toId) return 0;
      const from = activeCategory(this.store, fromId);
      const to = activeCategory(this.store, toId);
      if (!from || !to) throw new DomainError('CATEGORY_NOT_FOUND');
      if (from.kind !== to.kind) throw new DomainError('CATEGORY_KIND_MISMATCH');
      let moved = 0;
      const now = this.store.now();
      for (const t of this.store.transactions.values()) {
        if (t.categoryId === fromId && t.deletedAt === null) {
          this.store.transactions.set(t.id, { ...t, categoryId: toId, updatedAt: now });
          moved++;
        }
      }
      return moved;
    });
  }

  reorder(orderedIds: string[]): Promise<void> {
    return Promise.resolve().then(() => {
      for (const id of orderedIds)
        if (!activeCategory(this.store, id)) throw new DomainError('NOT_FOUND');
      orderedIds.forEach((id, index) => {
        const c = this.store.categories.get(id);
        if (c && c.sortOrder !== index) {
          this.store.categories.set(id, { ...c, sortOrder: index, updatedAt: this.store.now() });
        }
      });
    });
  }

  countTransactions(id: string): Promise<number> {
    return Promise.resolve(activeTxCount(this.store, id));
  }

  seedDefaults(): Promise<number> {
    if (this.store.categories.size > 0) return Promise.resolve(0);
    const now = this.store.now();
    for (const s of DEFAULT_CATEGORY_SEEDS) {
      const id = this.store.newId();
      this.store.categories.set(id, { id, ...s, createdAt: now, updatedAt: now, deletedAt: null });
    }
    return Promise.resolve(DEFAULT_CATEGORY_SEEDS.length);
  }
}

export class InMemorySettingsRepository implements SettingsRepository {
  constructor(private readonly store: Store) {}

  getAll(): Promise<Settings> {
    return Promise.resolve(
      settingsSchema.parse({ ...DEFAULT_SETTINGS, ...this.store.settings, schemaVersion: 1 }),
    );
  }

  async get<K extends keyof Settings>(key: K): Promise<Settings[K]> {
    return (await this.getAll())[key];
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    return Promise.resolve().then(() => {
      if (key === 'schemaVersion') throw new Error('schemaVersion is managed by migrations');
      this.store.settings = {
        ...this.store.settings,
        [key]: settingsSchema.shape[key].parse(value),
      };
    });
  }
}

export class InMemorySnapshotRepository implements SnapshotRepository {
  constructor(
    private readonly store: Store,
    private readonly settings: SettingsRepository,
  ) {}

  async exportSnapshot(): Promise<LedgerSnapshot> {
    return {
      categories: [...this.store.categories.values()]
        .map((c) => ({ ...c }))
        .sort((a, b) => cmp(a.kind, b.kind) || cmp(a.sortOrder, b.sortOrder) || cmp(a.id, b.id)),
      transactions: [...this.store.transactions.values()]
        .map((t) => ({ ...t }))
        .sort((a, b) => cmp(a.date, b.date) || cmp(a.id, b.id)),
      settings: await this.settings.getAll(),
    };
  }

  replaceAll(snapshot: LedgerSnapshot): Promise<void> {
    return Promise.resolve().then(() => {
      assertIntegrity(snapshot);
      const active = new Set<string>();
      for (const c of snapshot.categories) {
        if (c.deletedAt !== null) continue;
        const k = `${c.kind}|${asciiLower(c.name)}`;
        if (active.has(k)) throw new DomainError('DUPLICATE_CATEGORY_NAME');
        active.add(k);
      }
      this.store.categories = new Map(snapshot.categories.map((c) => [c.id, { ...c }]));
      this.store.transactions = new Map(snapshot.transactions.map((t) => [t.id, { ...t }]));
      const { schemaVersion: _ignored, ...rest } = snapshot.settings;
      this.store.settings = rest;
    });
  }

  mergeAll(snapshot: LedgerSnapshot): Promise<MergeResult> {
    return Promise.resolve().then(() => {
      assertIntegrity(snapshot);
      const result: MergeResult = {
        categories: { inserted: 0, updated: 0 },
        transactions: { inserted: 0, updated: 0 },
      };
      for (const incoming of snapshot.categories) {
        const local = this.store.categories.get(incoming.id);
        if (local && incoming.updatedAt <= local.updatedAt) continue;
        const taken = new Set(
          [...this.store.categories.values()]
            .filter((c) => c.kind === incoming.kind && c.deletedAt === null && c.id !== incoming.id)
            .map((c) => asciiLower(c.name)),
        );
        const name = incoming.deletedAt === null ? uniqueName(incoming.name, taken) : incoming.name;
        this.store.categories.set(incoming.id, { ...incoming, name });
        if (local) result.categories.updated++;
        else result.categories.inserted++;
      }
      for (const incoming of snapshot.transactions) {
        const local = this.store.transactions.get(incoming.id);
        if (!local) {
          this.store.transactions.set(incoming.id, { ...incoming });
          result.transactions.inserted++;
        } else if (incoming.updatedAt > local.updatedAt) {
          this.store.transactions.set(incoming.id, { ...incoming });
          result.transactions.updated++;
        }
      }
      return result;
    });
  }
}

function assertIntegrity(snapshot: LedgerSnapshot): void {
  const ids = new Set(snapshot.categories.map((c) => c.id));
  if (ids.size !== snapshot.categories.length)
    throw new DomainError('VALIDATION', 'Duplicate category id');
  if (new Set(snapshot.transactions.map((t) => t.id)).size !== snapshot.transactions.length) {
    throw new DomainError('VALIDATION', 'Duplicate transaction id');
  }
  for (const t of snapshot.transactions) {
    if (!ids.has(t.categoryId))
      throw new DomainError('VALIDATION', 'Transaction references an unknown category');
  }
}

function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(asciiLower(name))) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = name.slice(0, MAX_CATEGORY_NAME_LENGTH - suffix.length) + suffix;
    if (!taken.has(asciiLower(candidate))) return candidate;
  }
}

export interface InMemoryOptions {
  now?: () => string;
  newId?: () => string;
}

/** Fresh, empty in-memory repositories. */
export function createInMemoryRepositories(options: InMemoryOptions = {}): Repositories {
  const store: Store = {
    categories: new Map(),
    transactions: new Map(),
    settings: {},
    now: options.now ?? createMonotonicClock(),
    newId: options.newId ?? newId,
  };
  const settings = new InMemorySettingsRepository(store);
  return {
    transactions: new InMemoryTransactionRepository(store),
    categories: new InMemoryCategoryRepository(store),
    settings,
    snapshots: new InMemorySnapshotRepository(store, settings),
  };
}
