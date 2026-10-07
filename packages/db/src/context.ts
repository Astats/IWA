import { createMonotonicClock, newId } from '@budget/core';
import { drizzle } from 'drizzle-orm/sqlite-proxy';

import type { SqlDriver, SqlExecutor, SqlValue } from './driver';
import * as schema from './schema';

/** Drizzle query builder bound to an executor (the driver itself or an open transaction). */
export function createDb(executor: SqlExecutor) {
  return drizzle(
    async (sql, params, method) => {
      const bind = params as SqlValue[];
      if (method === 'run') {
        await executor.exec(sql, bind);
        return { rows: [] };
      }
      const rows = await executor.values(sql, bind);
      // sqlite-proxy expects a single positional row for `get`.
      return { rows: (method === 'get' ? rows[0] : rows) as unknown[] };
    },
    { schema },
  );
}

export type Db = ReturnType<typeof createDb>;

export interface RepoOptions {
  /** ISO timestamp source; must be monotonic (default: monotonic wall clock). */
  now?: () => string;
  newId?: () => string;
}

export interface RepoContext {
  driver: SqlDriver;
  db: Db;
  now: () => string;
  newId: () => string;
}

export function createContext(driver: SqlDriver, options: RepoOptions = {}): RepoContext {
  return {
    driver,
    db: createDb(driver),
    now: options.now ?? createMonotonicClock(),
    newId: options.newId ?? newId,
  };
}

/** Runs `fn` in a DB transaction with a Drizzle instance bound to it. */
export function inTransaction<T>(ctx: RepoContext, fn: (db: Db) => Promise<T>): Promise<T> {
  return ctx.driver.transaction((tx) => fn(createDb(tx)));
}
