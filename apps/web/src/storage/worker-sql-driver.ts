import { Mutex, type SqlDriver, type SqlExecutor, type SqlRow, type SqlValue } from '@budget/db';
import type { Remote } from 'comlink';

import type { DbWorkerApi } from './worker-api';

/**
 * Main-thread SqlDriver that forwards statements to the storage worker. A main-thread mutex keeps
 * a transaction's statements together: nothing else reaches the worker until it commits.
 */
export class WorkerSqlDriver implements SqlDriver {
  readonly #mutex = new Mutex();
  readonly #direct: SqlExecutor;

  constructor(private readonly api: Remote<DbWorkerApi>) {
    this.#direct = {
      exec: (sql, params = []) => this.api.exec(sql, [...params]),
      query: <T extends SqlRow>(sql: string, params: readonly SqlValue[] = []) =>
        this.api.query(sql, [...params]) as Promise<T[]>,
      values: (sql, params = []) => this.api.values(sql, [...params]),
    };
  }

  exec(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }> {
    return this.#mutex.run(() => this.#direct.exec(sql, params));
  }

  query<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
    return this.#mutex.run(() => this.#direct.query<T>(sql, params));
  }

  values(sql: string, params?: readonly SqlValue[]): Promise<SqlValue[][]> {
    return this.#mutex.run(() => this.#direct.values(sql, params));
  }

  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.#mutex.run(async () => {
      await this.api.begin();
      try {
        const result = await fn(this.#direct);
        await this.api.commit();
        return result;
      } catch (err) {
        await this.api.rollback();
        throw err;
      }
    });
  }

  export(): Promise<Uint8Array> {
    return this.#mutex.run(() => this.api.exportDatabase());
  }

  /** The worker owns the database lifetime (lock/unlock); closing the driver is a no-op. */
  close(): Promise<void> {
    return Promise.resolve();
  }
}
