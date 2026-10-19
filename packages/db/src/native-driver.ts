import { Mutex, type SqlDriver, type SqlExecutor, type SqlRow, type SqlValue } from './driver';

/**
 * The part of `@capacitor-community/sqlite`'s `SQLiteDBConnection` that the driver uses. Typed
 * structurally so this package has no Capacitor dependency (and tests can pass a fake).
 */
export interface PluginConnection {
  run(
    statement: string,
    values?: unknown[],
    transaction?: boolean,
  ): Promise<{ changes?: { changes?: number } }>;
  query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
  beginTransaction(): Promise<unknown>;
  commitTransaction(): Promise<unknown>;
  rollbackTransaction(): Promise<unknown>;
  isTransactionActive(): Promise<{ result?: boolean }>;
}

/**
 * Parameters cross the native bridge as JSON. bigint becomes a number when exact; blobs are
 * rejected because the plugin would bind a JSON array as text (the schema has no blob columns).
 */
function toBridge(value: SqlValue): unknown {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError('Integer parameter outside the safe range');
    }
    return Number(value);
  }
  if (value instanceof Uint8Array) throw new TypeError('Blob parameters are not supported');
  return value;
}

/** Rows arrive as JSON objects; blobs as arrays of byte values. */
function fromBridge(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new TypeError(`Unexpected value from the native SQLite bridge: ${typeof value}`);
}

function toRow(raw: unknown): SqlRow {
  const row: SqlRow = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    row[key] = fromBridge(value);
  }
  return row;
}

/**
 * SqlDriver over a native SQLite connection (Android/iOS, SQLCipher; BUILD_PLAN 4.2, AD6). The
 * database lives on the device, so writes are durable on commit and nothing is exported.
 *
 * Positional rows (Drizzle's `values`) follow the column order of the plugin's row objects:
 * Android keeps insertion order and the plugin reorders iOS rows by `ios_columns`. Queries must
 * not return duplicate or integer-like column names (none of this app's queries do).
 */
export class NativeSqlDriver implements SqlDriver {
  readonly #mutex = new Mutex();
  readonly #executor: SqlExecutor;
  #closed = false;

  constructor(
    private readonly conn: PluginConnection,
    private readonly onClose: () => Promise<void> = () => Promise.resolve(),
  ) {
    const params = (p: readonly SqlValue[] = []) => p.map(toBridge);
    const rows = async (sql: string, p?: readonly SqlValue[]) => {
      this.#assertOpen();
      const res = await this.conn.query(sql, params(p));
      return (res.values ?? []).map(toRow);
    };
    this.#executor = {
      exec: async (sql, p) => {
        this.#assertOpen();
        // transaction=false: statements run in the caller's transaction (or autocommit).
        const res = await this.conn.run(sql, params(p), false);
        return { changes: res.changes?.changes ?? 0 };
      },
      query: async <T extends SqlRow>(sql: string, p?: readonly SqlValue[]) =>
        (await rows(sql, p)) as T[],
      values: async (sql, p) => (await rows(sql, p)).map((r) => Object.values(r)),
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Database is closed');
  }

  exec(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }> {
    return this.#mutex.run(() => this.#executor.exec(sql, params));
  }

  query<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
    return this.#mutex.run(() => this.#executor.query<T>(sql, params));
  }

  values(sql: string, params?: readonly SqlValue[]): Promise<SqlValue[][]> {
    return this.#mutex.run(() => this.#executor.values(sql, params));
  }

  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.#mutex.run(async () => {
      this.#assertOpen();
      await this.conn.beginTransaction();
      try {
        const result = await fn(this.#executor);
        await this.conn.commitTransaction();
        return result;
      } catch (err) {
        if ((await this.conn.isTransactionActive()).result) await this.conn.rollbackTransaction();
        throw err;
      }
    });
  }

  /** The database stays on the device (SQLCipher); there are no bytes to hand out. */
  export(): Promise<Uint8Array> {
    return Promise.reject(new Error('NativeSqlDriver does not export the database'));
  }

  close(): Promise<void> {
    return this.#mutex.run(async () => {
      if (this.#closed) return;
      this.#closed = true;
      await this.onClose();
    });
  }
}
