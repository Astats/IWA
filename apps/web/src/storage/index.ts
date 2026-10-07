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

export interface DbWorkerHandle {
  api: Remote<DbWorkerApi>;
  /** Rejects if the worker fails to load or crashes; never resolves otherwise. */
  failed: Promise<never>;
  terminate: () => void;
}

/** Starts a storage worker and returns its typed RPC proxy. */
export function startDbWorker(): DbWorkerHandle {
  const worker = new Worker(new URL('./db.worker.ts', import.meta.url), {
    type: 'module',
    name: 'budget-db',
  });
  const failed = new Promise<never>((_, reject) => {
    const fail = () => {
      reject(new Error('Storage worker failed'));
    };
    worker.addEventListener('error', fail);
    worker.addEventListener('messageerror', fail);
  });
  failed.catch(() => undefined); // observed via Promise.race by callers
  return { api: wrap<DbWorkerApi>(worker), failed, terminate: () => worker.terminate() };
}

/** Repositories backed by the worker's database (BUILD_PLAN AD7). */
export function createWorkerRepositories(api: Remote<DbWorkerApi>): Repositories {
  return createSqliteRepositories(new WorkerSqlDriver(api));
}
