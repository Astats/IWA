import type { Repositories } from '@budget/core';

import { SqliteCategoryRepository } from './category-repository';
import { createContext, type RepoOptions } from './context';
import type { SqlDriver } from './driver';
import { SQLITE_MIGRATIONS } from './migrations.generated';
import { migrate } from './migrator';
import { SqliteSettingsRepository } from './settings-repository';
import { SqliteSnapshotRepository } from './snapshot-repository';
import { SqliteTransactionRepository } from './transaction-repository';

export * from './driver';
export { currentSchemaVersion, migrate, type Migration } from './migrator';
export { SQLITE_MIGRATIONS } from './migrations.generated';
export type { RepoOptions } from './context';
export { SqliteCategoryRepository } from './category-repository';
export { SqliteSettingsRepository } from './settings-repository';
export { SqliteSnapshotRepository } from './snapshot-repository';
export { SqliteTransactionRepository } from './transaction-repository';

/** Builds all repositories over a driver. Run {@link migrateSqlite} first. */
export function createSqliteRepositories(
  driver: SqlDriver,
  options: RepoOptions = {},
): Repositories {
  const ctx = createContext(driver, options);
  const settings = new SqliteSettingsRepository(ctx);
  return {
    transactions: new SqliteTransactionRepository(ctx),
    categories: new SqliteCategoryRepository(ctx),
    settings,
    snapshots: new SqliteSnapshotRepository(ctx, settings),
  };
}

/** Applies the bundled SQLite migrations. */
export function migrateSqlite(driver: SqlDriver): Promise<number[]> {
  return migrate(driver, SQLITE_MIGRATIONS);
}
