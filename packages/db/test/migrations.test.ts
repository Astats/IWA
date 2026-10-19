import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { settingsSchema, type NewTransaction } from '@budget/core';
import { describe, expect, it } from 'vitest';

import {
  createSqliteRepositories,
  currentSchemaVersion,
  migrate,
  migrateSqlite,
  SQLITE_MIGRATIONS,
} from '../src';
import { SqliteWasmDriver } from '../src/sqlite-wasm-driver';

const goldenDir = path.resolve(import.meta.dirname, '../../../test-data/db');
const LATEST = SQLITE_MIGRATIONS.length;

async function freshDriver() {
  return SqliteWasmDriver.open();
}

/** Deterministic clock/ids so golden fixtures are reproducible. */
function deterministic() {
  let t = Date.parse('2026-03-15T10:00:00.000Z');
  let n = 0;
  return {
    now: () => new Date((t += 1000)).toISOString(),
    newId: () => `0192f0c1-7a3b-7c3d-8e4f-${String(++n).padStart(12, '0')}`,
  };
}

describe('migrations', () => {
  it('fresh install reaches the latest version with all tables and indexes', async () => {
    const driver = await freshDriver();

    const applied = await migrateSqlite(driver);

    expect(applied).toEqual(SQLITE_MIGRATIONS.map((m) => m.version));
    expect(await currentSchemaVersion(driver)).toBe(LATEST);
    const objects = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    expect(objects.map((o) => o.name)).toEqual([
      'categories',
      'categories_kind_name_active_uq',
      'schema_migrations',
      'settings',
      'transactions',
      'transactions_category_idx',
      'transactions_date_idx',
      'transactions_deleted_idx',
      'transactions_kind_date_idx',
    ]);
    await driver.close();
  });

  it('is idempotent', async () => {
    const driver = await freshDriver();
    await migrateSqlite(driver);

    expect(await migrateSqlite(driver)).toEqual([]);
    await driver.close();
  });

  it('a failing migration rolls back completely', async () => {
    const driver = await freshDriver();
    await migrateSqlite(driver);
    const broken = {
      version: LATEST + 1,
      name: 'broken',
      statements: ['CREATE TABLE extra (x INTEGER)', 'INSERT INTO missing_table VALUES (1)'],
    };

    await expect(migrate(driver, [...SQLITE_MIGRATIONS, broken])).rejects.toThrow();

    expect(await currentSchemaVersion(driver)).toBe(LATEST);
    expect(await driver.query("SELECT name FROM sqlite_master WHERE name = 'extra'")).toEqual([]);
    await driver.close();
  });

  it('rejects migration lists with gaps', async () => {
    const driver = await freshDriver();

    await expect(migrate(driver, [{ version: 2, name: 'x', statements: [] }])).rejects.toThrow(
      /without gaps/,
    );
    await driver.close();
  });

  it('enforces CHECK constraints and foreign keys at the SQL level', async () => {
    const driver = await freshDriver();
    await migrateSqlite(driver);

    await expect(
      driver.exec(
        "INSERT INTO transactions (id, kind, amount_minor, currency, category_id, date, note, created_at, updated_at) VALUES ('a', 'expense', 1, 'EUR', 'missing', '2026-01-01', '', 'x', 'x')",
      ),
    ).rejects.toThrow(/FOREIGN KEY/i);
    await expect(
      driver.exec(
        "INSERT INTO categories (id, name, kind, color, icon, created_at, updated_at) VALUES ('c', 'n', 'both', '#000000', 'tag', 'x', 'x')",
      ),
    ).rejects.toThrow(/CHECK/i);
    await driver.close();
  });

  it('bundled migrations match migrations/sqlite/*.sql', () => {
    const dir = path.resolve(import.meta.dirname, '../migrations/sqlite');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    expect(SQLITE_MIGRATIONS.map((m) => `${m.name}.sql`)).toEqual(files);
    for (const m of SQLITE_MIGRATIONS) {
      const sql = readFileSync(path.join(dir, `${m.name}.sql`), 'utf8').replaceAll('\r\n', '\n');
      expect(m.statements).toEqual(
        sql
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
  });
});

describe('upgrade from golden databases (one per released schema version)', () => {
  // To add a fixture after a schema change: UPDATE_GOLDEN=1 pnpm vitest run --project db migrations
  it.runIf(process.env.UPDATE_GOLDEN === '1')(
    'writes the golden fixture for the latest schema',
    async () => {
      const driver = await freshDriver();
      await migrateSqlite(driver);
      const repos = createSqliteRepositories(driver, deterministic());
      await repos.categories.seedDefaults();
      const cats = await repos.categories.list();
      const food = cats.find((c) => c.name === 'Food' && c.kind === 'expense')!;
      const salary = cats.find((c) => c.name === 'Salary')!;
      const items: NewTransaction[] = [
        {
          kind: 'expense',
          amountMinor: 1250,
          currency: 'EUR',
          categoryId: food.id,
          date: '2026-03-01',
          note: 'Groceries ā č 🍎',
        },
        {
          kind: 'income',
          amountMinor: 350000,
          currency: 'EUR',
          categoryId: salary.id,
          date: '2026-03-02',
          note: 'Salary',
        },
        {
          kind: 'expense',
          amountMinor: 999,
          currency: 'USD',
          categoryId: food.id,
          date: '2026-03-03',
          note: '',
        },
      ];
      for (const item of items) await repos.transactions.create(item);
      const deleted = await repos.transactions.create({ ...items[0]!, note: 'deleted later' });
      await repos.transactions.softDelete(deleted.id);
      await repos.settings.set('baseCurrency', 'EUR');
      mkdirSync(goldenDir, { recursive: true });
      writeFileSync(path.join(goldenDir, `schema-v${LATEST}.sqlite`), await driver.export());
      writeFileSync(
        path.join(goldenDir, `schema-v${LATEST}.expected.json`),
        JSON.stringify(await repos.snapshots.exportSnapshot(), null, 2) + '\n',
      );
      await driver.close();
    },
  );

  const fixtures = existsSync(goldenDir)
    ? readdirSync(goldenDir).filter((f) => /^schema-v\d+\.sqlite$/.test(f))
    : [];

  it('has at least one golden database', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)('%s upgrades to the latest schema with data preserved', async (file) => {
    const bytes = new Uint8Array(readFileSync(path.join(goldenDir, file)));
    const expected: unknown = JSON.parse(
      readFileSync(path.join(goldenDir, file.replace('.sqlite', '.expected.json')), 'utf8'),
    );
    const driver = await SqliteWasmDriver.open(bytes);

    await migrateSqlite(driver);
    const snapshot = await createSqliteRepositories(driver).snapshots.exportSnapshot();

    expect(await currentSchemaVersion(driver)).toBe(LATEST);
    expect({ ...snapshot, settings: { ...snapshot.settings, schemaVersion: 0 } }).toEqual({
      ...(expected as typeof snapshot),
      // Golden JSON is frozen at its release; settings added later appear with their defaults.
      settings: settingsSchema.parse({
        ...(expected as typeof snapshot).settings,
        schemaVersion: 0,
      }),
    });
    await driver.close();
  });
});
