/** Values that can be bound to or read from SQLite. */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

/** Statement execution, available both on a driver and inside one of its transactions. */
export interface SqlExecutor {
  /** Runs a statement that returns no rows. Returns the number of changed rows. */
  exec(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  /** Runs a query and returns rows as objects keyed by column name. */
  query<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  /** Runs a query and returns rows as arrays of values (positional; used by Drizzle). */
  values(sql: string, params?: readonly SqlValue[]): Promise<SqlValue[][]>;
}

/**
 * Storage-engine abstraction (AD4). Implementations: sqlite-wasm (Node tests and the web worker),
 * WorkerSqlDriver (main thread → worker), NativeSqlDriver (Phase 4).
 *
 * Calls are serialized: while a transaction is open, other calls wait until it ends, so a
 * transaction never sees interleaved statements from elsewhere.
 */
export interface SqlDriver extends SqlExecutor {
  /** Runs `fn` inside BEGIN IMMEDIATE … COMMIT; rolls back when `fn` throws. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /** Serialized database bytes (for encrypted persistence and backups). */
  export(): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** FIFO async mutex used by drivers to serialize statements and transactions. */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
