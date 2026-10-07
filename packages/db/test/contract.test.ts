import { createInMemoryRepositories } from '@budget/core/testing';

import { createSqliteRepositories, migrateSqlite } from '../src';
import { SqliteWasmDriver } from '../src/sqlite-wasm-driver';
import { runRepositoryContract } from './contract/repositories.contract';

runRepositoryContract('sqlite-wasm (Node)', async () => {
  const driver = await SqliteWasmDriver.open();
  await migrateSqlite(driver);
  return { repos: createSqliteRepositories(driver), close: () => driver.close() };
});

runRepositoryContract('in-memory fakes', () =>
  Promise.resolve({ repos: createInMemoryRepositories() }),
);
