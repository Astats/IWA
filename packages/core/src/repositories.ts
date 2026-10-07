import type {
  Category,
  CategoryPatch,
  DateRange,
  Kind,
  NewCategory,
  NewTransaction,
  Settings,
  Transaction,
  TransactionPatch,
  TransactionQuery,
} from './domain';

/** Income/expense/balance for one currency (no FX conversion; BUILD_PLAN §4.2). */
export interface CurrencyTotals {
  currency: string;
  income: bigint;
  expense: bigint;
  balance: bigint;
}

export interface PeriodTotals {
  dateFrom: string;
  dateTo: string;
  /** One entry per currency that has transactions in the period, sorted by currency code. */
  byCurrency: CurrencyTotals[];
}

export interface CategoryTotal {
  categoryId: string;
  categoryName: string;
  color: string;
  currency: string;
  total: bigint;
  count: number;
}

export interface ExportOptions {
  /** Include soft-deleted rows (tombstones), e.g. for backups. Default false. */
  includeDeleted?: boolean;
}

export interface TransactionRepository {
  list(q: TransactionQuery): Promise<{ items: Transaction[]; total: number }>;
  get(id: string): Promise<Transaction | null>;
  create(input: NewTransaction): Promise<Transaction>;
  update(id: string, patch: TransactionPatch): Promise<Transaction>;
  softDelete(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  totals(range: DateRange): Promise<PeriodTotals>;
  byCategory(range: DateRange & { kind: Kind }): Promise<CategoryTotal[]>;
  /** Inserts all items in a single DB transaction: one invalid item → nothing is inserted. */
  bulkInsert(items: NewTransaction[]): Promise<number>;
  exportAll(options?: ExportOptions): AsyncIterable<Transaction>;
}

export interface CategoryListOptions {
  kind?: Kind;
  includeDeleted?: boolean;
}

export interface CategoryRepository {
  /** Sorted by kind, then sortOrder, then name. */
  list(options?: CategoryListOptions): Promise<Category[]>;
  get(id: string): Promise<Category | null>;
  create(input: NewCategory): Promise<Category>;
  update(id: string, patch: CategoryPatch): Promise<Category>;
  /** Blocked with CATEGORY_IN_USE while non-deleted transactions reference the category. */
  softDelete(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  /** Moves all non-deleted transactions from one category to another of the same kind. */
  reassignTransactions(fromId: string, toId: string): Promise<number>;
  /** Persists a new order: `orderedIds[i]` gets `sortOrder = i`. */
  reorder(orderedIds: string[]): Promise<void>;
  countTransactions(id: string): Promise<number>;
  /** Inserts the default categories when none exist yet. Returns how many were created. */
  seedDefaults(): Promise<number>;
}

export interface SettingsRepository {
  getAll(): Promise<Settings>;
  get<K extends keyof Settings>(key: K): Promise<Settings[K]>;
  set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>;
}

/** Full data snapshot used by backups (all rows, including tombstones). */
export interface LedgerSnapshot {
  categories: Category[];
  transactions: Transaction[];
  settings: Settings;
}

export interface MergeResult {
  categories: { inserted: number; updated: number };
  transactions: { inserted: number; updated: number };
}

/** Whole-ledger operations for backup/restore. Each call runs in one DB transaction. */
export interface SnapshotRepository {
  exportSnapshot(): Promise<LedgerSnapshot>;
  /** Deletes all data and inserts the snapshot. */
  replaceAll(snapshot: LedgerSnapshot): Promise<void>;
  /** Merges by id; the row with the newest `updatedAt` wins (tombstones included). */
  mergeAll(snapshot: LedgerSnapshot): Promise<MergeResult>;
}

export interface Repositories {
  transactions: TransactionRepository;
  categories: CategoryRepository;
  settings: SettingsRepository;
  snapshots: SnapshotRepository;
}
