import { createSqliteRepositories } from '@budget/db';
import type { Repositories } from '@budget/core';
import { wrap, type Remote } from 'comlink';

import { WorkerSqlDriver } from './worker-sql-driver';
import type { DbWorkerApi } from './worker-api';

export type {
  DbWorkerApi,
  StorageKind,
  VaultErrorCode,
  VaultResult,
  VaultStatus,
} from './worker-api';

/** Starts a storage worker and returns its typed RPC proxy. */
export function startDbWorker(): { api: Remote<DbWorkerApi>; terminate: () => void } {
  const worker = new Worker(new URL('./db.worker.ts', import.meta.url), {
    type: 'module',
    name: 'budget-db',
  });
  return { api: wrap<DbWorkerApi>(worker), terminate: () => worker.terminate() };
}

/** Repositories backed by the worker's database (BUILD_PLAN AD7). */
export function createWorkerRepositories(api: Remote<DbWorkerApi>): Repositories {
  return createSqliteRepositories(new WorkerSqlDriver(api));
}
