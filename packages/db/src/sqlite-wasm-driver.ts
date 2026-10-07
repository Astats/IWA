import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';

import { Mutex, type SqlDriver, type SqlExecutor, type SqlRow, type SqlValue } from './driver';

let modulePromise: Promise<Sqlite3Static> | null = null;

/** Loads the sqlite-wasm module once per realm (worker or Node process). */
export function loadSqlite(): Promise<Sqlite3Static> {
  modulePromise ??= sqlite3InitModule();
  return modulePromise;
}

function toPlainRow(row: Record<string, unknown>): SqlRow {
  return { ...row } as SqlRow;
}

/**
 * SqlDriver over an in-memory sqlite-wasm database. Used directly in Node tests and inside the web
 * storage worker (which encrypts `export()` bytes for persistence; AD5).
 */
export class SqliteWasmDriver implements SqlDriver {
  readonly #mutex = new Mutex();
  readonly #executor: SqlExecutor;
  #closed = false;

  private constructor(
    private readonly sqlite3: Sqlite3Static,
    private readonly db: Database,
  ) {
    const run = (sql: string, params: readonly SqlValue[] = []) => {
      this.#assertOpen();
      return { db: this.db, sql, bind: params.length > 0 ? [...params] : undefined };
    };
    this.#executor = {
      exec: (sql, params) => {
        const { db, bind } = run(sql, params);
        db.exec({ sql, ...(bind ? { bind } : {}) });
        return Promise.resolve({ changes: db.changes() });
      },
      query: <T extends SqlRow>(sql: string, params?: readonly SqlValue[]) => {
        const { db, bind } = run(sql, params);
        return Promise.resolve(db.selectObjects(sql, bind).map(toPlainRow) as T[]);
      },
      values: (sql, params) => {
        const { db, bind } = run(sql, params);
        return Promise.resolve(db.selectArrays(sql, bind) as SqlValue[][]);
      },
    };
  }

  /** Opens an in-memory database, optionally loaded from serialized bytes. */
  static async open(bytes?: Uint8Array): Promise<SqliteWasmDriver> {
    const sqlite3 = await loadSqlite();
    const db = new sqlite3.oo1.DB(':memory:', 'c');
    if (bytes && bytes.length > 0) {
      const p = sqlite3.wasm.allocFromTypedArray(bytes);
      const rc = sqlite3.capi.sqlite3_deserialize(
        db.pointer as number,
        'main',
        p,
        bytes.length,
        bytes.length,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
      );
      if (rc !== sqlite3.capi.SQLITE_OK) {
        db.close();
        throw new Error(`sqlite3_deserialize failed (${rc})`);
      }
    }
    db.exec('PRAGMA foreign_keys = ON');
    return new SqliteWasmDriver(sqlite3, db);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Database is closed');
  }

  /** True when no transaction is open (used to decide when a write is committed). */
  get autocommit(): boolean {
    return this.sqlite3.capi.sqlite3_get_autocommit(this.db.pointer as number) !== 0;
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
      await this.#executor.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this.#executor);
        await this.#executor.exec('COMMIT');
        return result;
      } catch (err) {
        if (!this.autocommit) await this.#executor.exec('ROLLBACK');
        throw err;
      }
    });
  }

  export(): Promise<Uint8Array> {
    return this.#mutex.run(() => {
      this.#assertOpen();
      return Promise.resolve(this.sqlite3.capi.sqlite3_js_db_export(this.db));
    });
  }

  close(): Promise<void> {
    return this.#mutex.run(() => {
      if (!this.#closed) {
        this.#closed = true;
        this.db.close();
      }
      return Promise.resolve();
    });
  }
}
