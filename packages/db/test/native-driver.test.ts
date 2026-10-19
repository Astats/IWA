import { describe, expect, it } from 'vitest';

import { createSqliteRepositories, migrateSqlite } from '../src';
import { NativeSqlDriver } from '../src/native-driver';
import { runRepositoryContract } from './contract/repositories.contract';
import { FakePluginConnection } from '../src/testing/fake-plugin-connection';

async function openDriver() {
  const conn = await FakePluginConnection.open();
  const driver = new NativeSqlDriver(conn, () => conn.db.close());
  return { conn, driver };
}

runRepositoryContract('native driver (plugin semantics, Node)', async () => {
  const { driver } = await openDriver();
  await migrateSqlite(driver);
  return { repos: createSqliteRepositories(driver), close: () => driver.close() };
});

describe('NativeSqlDriver', () => {
  it('returns objects and positional rows in column order', async () => {
    const { driver } = await openDriver();
    await driver.exec('CREATE TABLE t (b TEXT, a INTEGER, c REAL)');
    await driver.exec('INSERT INTO t VALUES (?, ?, ?)', ['x', 7n, 1.5]);

    expect(await driver.query('SELECT b, a, c FROM t')).toEqual([{ b: 'x', a: 7, c: 1.5 }]);
    expect(await driver.values('SELECT c, b, a FROM t')).toEqual([[1.5, 'x', 7]]);
    expect(await driver.values('SELECT a FROM t WHERE b = ?', ['nope'])).toEqual([]);
  });

  it('reports changed rows and never lets the plugin wrap statements in transactions', async () => {
    const { conn, driver } = await openDriver();
    await driver.exec('CREATE TABLE t (a INTEGER)');
    await driver.exec('INSERT INTO t VALUES (1), (2), (3)');

    expect(await driver.exec('DELETE FROM t WHERE a > ?', [1])).toEqual({ changes: 2 });
    expect(conn.calls.filter((c) => c.startsWith('run:'))).toEqual(
      Array.from({ length: 3 }, () => 'run:false'),
    );
  });

  it('commits a transaction and rolls back a failing one', async () => {
    const { conn, driver } = await openDriver();
    await driver.exec('CREATE TABLE t (a INTEGER NOT NULL)');

    await driver.transaction(async (tx) => {
      await tx.exec('INSERT INTO t VALUES (1)');
    });
    await expect(
      driver.transaction(async (tx) => {
        await tx.exec('INSERT INTO t VALUES (2)');
        await tx.exec('INSERT INTO t VALUES (NULL)');
      }),
    ).rejects.toThrow();

    expect(await driver.values('SELECT a FROM t')).toEqual([[1]]);
    expect((await conn.isTransactionActive()).result).toBe(false);
  });

  it('serializes statements behind an open transaction', async () => {
    const { driver } = await openDriver();
    await driver.exec('CREATE TABLE t (a INTEGER)');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const tx = driver.transaction(async (t) => {
      await t.exec('INSERT INTO t VALUES (1)');
      await gate;
      await t.exec('INSERT INTO t VALUES (2)');
    });
    const outside = driver.values('SELECT count(*) AS n FROM t');
    release();
    await tx;

    expect(await outside).toEqual([[2]]);
  });

  it('rejects parameters the bridge cannot carry exactly', async () => {
    const { driver } = await openDriver();

    await expect(driver.exec('SELECT ?', [2n ** 60n])).rejects.toThrow(RangeError);
    await expect(driver.exec('SELECT ?', [new Uint8Array([1])])).rejects.toThrow(TypeError);
  });

  it('does not export and refuses calls after close', async () => {
    const { driver } = await openDriver();

    await expect(driver.export()).rejects.toThrow(/does not export/);
    await driver.close();
    await driver.close();
    await expect(driver.query('SELECT 1')).rejects.toThrow(/closed/);
  });
});
