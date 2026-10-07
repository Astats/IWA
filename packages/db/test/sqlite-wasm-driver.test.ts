import { describe, expect, it } from 'vitest';

import { Mutex } from '../src/driver';
import { SqliteWasmDriver } from '../src/sqlite-wasm-driver';

async function withTable() {
  const driver = await SqliteWasmDriver.open();
  await driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  return driver;
}

describe('SqliteWasmDriver', () => {
  it('executes parameterized statements and returns objects or arrays', async () => {
    const driver = await withTable();

    const { changes } = await driver.exec('INSERT INTO t (id, v) VALUES (?, ?), (?, ?)', [
      1,
      'a',
      2,
      "b'); DROP TABLE t; --",
    ]);

    expect(changes).toBe(2);
    expect(await driver.query('SELECT id, v FROM t ORDER BY id')).toEqual([
      { id: 1, v: 'a' },
      { id: 2, v: "b'); DROP TABLE t; --" },
    ]);
    expect(await driver.values('SELECT id FROM t WHERE v = ?', ['a'])).toEqual([[1]]);
    expect(await driver.values('SELECT 9007199254740993')).toEqual([[9007199254740993n]]);
  });

  it('commits a transaction', async () => {
    const driver = await withTable();

    const result = await driver.transaction(async (tx) => {
      await tx.exec("INSERT INTO t (v) VALUES ('x')");
      return tx.query('SELECT COUNT(*) AS n FROM t');
    });

    expect(result).toEqual([{ n: 1 }]);
    expect(driver.autocommit).toBe(true);
  });

  it('rolls back when the transaction function throws', async () => {
    const driver = await withTable();

    await expect(
      driver.transaction(async (tx) => {
        await tx.exec("INSERT INTO t (v) VALUES ('x')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await driver.query('SELECT * FROM t')).toEqual([]);
    expect(driver.autocommit).toBe(true);
  });

  it('serializes other calls behind an open transaction', async () => {
    const driver = await withTable();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const tx = driver.transaction(async (t) => {
      await t.exec("INSERT INTO t (v) VALUES ('in-tx')");
      order.push('tx-insert');
      await gate;
      order.push('tx-end');
    });
    const outside = driver.query('SELECT COUNT(*) AS n FROM t').then((rows) => {
      order.push('outside');
      return rows;
    });
    release();
    await tx;

    expect(await outside).toEqual([{ n: 1 }]);
    expect(order).toEqual(['tx-insert', 'tx-end', 'outside']);
  });

  it('exports bytes that reopen to the same data', async () => {
    const driver = await withTable();
    await driver.exec("INSERT INTO t (v) VALUES ('persist me')");

    const bytes = await driver.export();
    const reopened = await SqliteWasmDriver.open(bytes);

    expect(await reopened.query('SELECT v FROM t')).toEqual([{ v: 'persist me' }]);
  });

  it('rejects corrupt bytes and use after close', async () => {
    await expect(
      SqliteWasmDriver.open(new Uint8Array(4096).fill(1)).then((d) => d.query('SELECT * FROM t')),
    ).rejects.toThrow();
    const driver = await withTable();

    await driver.close();
    await driver.close();

    await expect(driver.query('SELECT 1')).rejects.toThrow('closed');
    await expect(driver.export()).rejects.toThrow('closed');
  });
});

describe('Mutex', () => {
  it('keeps running after a rejected task', async () => {
    const m = new Mutex();

    await expect(m.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await m.run(() => Promise.resolve(42))).toBe(42);
  });
});
