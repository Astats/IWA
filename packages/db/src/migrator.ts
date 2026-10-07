import type { SqlDriver, SqlExecutor } from './driver';

export interface Migration {
  /** 1-based, strictly increasing. */
  version: number;
  name: string;
  statements: readonly string[];
}

const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL
)`;

/** Highest applied migration version (0 for an empty database). Read-only. */
export async function currentSchemaVersion(executor: SqlExecutor): Promise<number> {
  const exists = await executor.query(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if (exists.length === 0) return 0;
  const rows = await executor.query<{ v: number | bigint | null }>(
    'SELECT MAX(version) AS v FROM schema_migrations',
  );
  return Number(rows[0]?.v ?? 0);
}

/**
 * Applies pending migrations in order. Each migration runs in its own transaction together with
 * its `schema_migrations` row, so a failing migration rolls back completely.
 * Returns the versions that were applied.
 */
export async function migrate(
  driver: SqlDriver,
  migrations: readonly Migration[],
  now: () => string = () => new Date().toISOString(),
): Promise<number[]> {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migration versions must be 1..n without gaps`);
  });
  await driver.exec(CREATE_MIGRATIONS_TABLE);
  const current = await currentSchemaVersion(driver);
  const applied: number[] = [];
  for (const m of sorted.filter((x) => x.version > current)) {
    await driver.transaction(async (tx) => {
      for (const statement of m.statements) await tx.exec(statement);
      await tx.exec('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [
        m.version,
        now(),
      ]);
    });
    applied.push(m.version);
  }
  return applied;
}
