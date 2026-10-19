import type { SqlValue } from '../driver';
import type { PluginConnection } from '../native-driver';
import { SqliteWasmDriver } from '../sqlite-wasm-driver';

/** JSON round trip, as the Capacitor bridge does (bigint would throw, like the real bridge). */
const overBridge = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Behaves like `@capacitor-community/sqlite`'s connection on Android: parameters and rows travel
 * as JSON, rows are objects keyed by column name, `run` and `query` are separate calls and
 * transactions use begin/commit/rollback calls (BEGIN EXCLUSIVE in the native code).
 */
export class FakePluginConnection implements PluginConnection {
  calls: string[] = [];
  #inTransaction = false;

  private constructor(readonly db: SqliteWasmDriver) {}

  static async open(): Promise<FakePluginConnection> {
    return new FakePluginConnection(await SqliteWasmDriver.open());
  }

  async run(statement: string, values: unknown[] = [], transaction = true) {
    this.calls.push(`run:${String(transaction)}`);
    if (transaction) throw new Error('the driver must not let the plugin open transactions');
    const res = await this.db.exec(statement, overBridge(values) as SqlValue[]);
    return overBridge({ changes: { changes: res.changes, lastId: -1 } });
  }

  async query(statement: string, values: unknown[] = []) {
    this.calls.push('query');
    const rows = await this.db.query(statement, overBridge(values) as SqlValue[]);
    return overBridge({ values: rows });
  }

  async beginTransaction() {
    if (this.#inTransaction) throw new Error('Already in transaction');
    await this.db.exec('BEGIN EXCLUSIVE');
    this.#inTransaction = true;
    return {};
  }

  async commitTransaction() {
    if (!this.#inTransaction) throw new Error('No transaction active');
    this.#inTransaction = false;
    await this.db.exec('COMMIT');
    return {};
  }

  async rollbackTransaction() {
    if (this.#inTransaction) {
      this.#inTransaction = false;
      await this.db.exec('ROLLBACK');
    }
    return {};
  }

  isTransactionActive() {
    return Promise.resolve({ result: this.#inTransaction });
  }
}
