import { createSqliteRepositories, migrateSqlite } from '@budget/db';
import { NativeSqlDriver } from '@budget/db/native';

import { runRepositoryContract } from '../../../packages/db/test/contract/repositories.contract';
import { createCapacitorSqlitePort } from '../src/storage/native/capacitor-sqlite';

import { run, type TestResult } from './vitest-shim';

/*
 * Instrumented contract run (BUILD_PLAN 4.2 DoD): the repository contract suite, unchanged,
 * against NativeSqlDriver + @capacitor-community/sqlite with SQLCipher on a device or emulator.
 * Built and driven by scripts/native-contract.mjs; never part of the app build.
 */

const port = createCapacitorSqlitePort();
const TEST_SECRET = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
  b.toString(16).padStart(2, '0'),
).join('');
let seq = 0;

runRepositoryContract('native SQLCipher (device)', async () => {
  // A fresh database per test (the app is reinstalled before the run); closing deletes it.
  const db = await port.open(`contract-${String(++seq)}`, true);
  const driver = new NativeSqlDriver(db.conn, db.delete);
  await migrateSqlite(driver);
  return { repos: createSqliteRepositories(driver), close: () => driver.close() };
});

const out = document.getElementById('out');
const log = (line: string) => {
  console.info(`[contract] ${line}`);
  if (out) out.textContent += `${line}\n`;
};

async function main(): Promise<void> {
  if (await port.isSecretStored()) await port.clearSecret();
  await port.setSecret(TEST_SECRET);
  let results: TestResult[] = [];
  try {
    results = await run((r) => {
      log(
        `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ` — ${r.error}` : ''} (${String(r.ms)} ms)`,
      );
    });
  } finally {
    await port.clearSecret();
  }
  const failed = results.filter((r) => !r.ok).length;
  log(`DONE passed=${String(results.length - failed)} failed=${String(failed)}`);
}

main().catch((err: unknown) => {
  log(`DONE passed=0 failed=1 error=${err instanceof Error ? err.message : String(err)}`);
});
