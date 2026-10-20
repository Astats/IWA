import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

import type { NativeSqlitePort } from './native-vault';

/** `@capacitor-community/sqlite` behind the native vault's port (Android/iOS only). */
export function createCapacitorSqlitePort(): NativeSqlitePort {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  // Setting or clearing the secret closes every database natively, but the JS side keeps its
  // connection objects: resync, so the next open creates a fresh connection.
  const resync = () => sqlite.checkConnectionsConsistency().catch(() => undefined);
  return {
    isSecretStored: async () => (await sqlite.isSecretStored()).result === true,
    async setSecret(secret) {
      try {
        await sqlite.setEncryptionSecret(secret);
      } finally {
        await resync();
      }
    },
    async clearSecret() {
      try {
        await sqlite.clearEncryptionSecret();
      } finally {
        await resync();
      }
    },
    async open(name, encrypted) {
      const conn = (await sqlite.isConnection(name, false)).result
        ? await sqlite.retrieveConnection(name, false)
        : await sqlite.createConnection(
            name,
            encrypted,
            encrypted ? 'secret' : 'no-encryption',
            1,
            false,
          );
      try {
        await conn.open();
      } catch (err) {
        await sqlite.closeConnection(name, false).catch(() => undefined);
        throw err;
      }
      const close = () => sqlite.closeConnection(name, false);
      return {
        conn,
        close,
        // Deleting an open database skips the plugin's re-open (which needs the right key).
        async delete() {
          try {
            await conn.delete();
          } finally {
            await close().catch(() => undefined);
          }
        },
      };
    },
  };
}
