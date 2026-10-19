import type { VaultSlot, VaultStore } from '@budget/crypto';

import { assertSafeName } from './vault-common';
import type { StorageKind } from './worker-api';

/** Vault slots plus named side files (e.g. the pre-restore backup). Only ciphertext is stored. */
export interface FileVaultStore extends VaultStore {
  readonly kind: StorageKind;
  readFile(name: string): Promise<Uint8Array | null>;
  writeFile(name: string, data: Uint8Array): Promise<void>;
}

const slotFile = (slot: VaultSlot) => `budget-${slot}.vault`;

/** Minimal typing for OPFS sync access handles (only declared in the webworker lib). */
interface SyncAccessHandle {
  truncate(size: number): void;
  write(buffer: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
}
type SyncFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
};

/** Origin Private File System store (dedicated worker only: uses sync access handles). */
class OpfsStore implements FileVaultStore {
  readonly kind = 'opfs';

  constructor(private readonly dir: FileSystemDirectoryHandle) {}

  read(slot: VaultSlot): Promise<Uint8Array | null> {
    return this.readFile(slotFile(slot));
  }

  write(slot: VaultSlot, data: Uint8Array): Promise<void> {
    return this.writeFile(slotFile(slot), data);
  }

  async readFile(name: string): Promise<Uint8Array | null> {
    assertSafeName(name);
    let handle: FileSystemFileHandle;
    try {
      handle = await this.dir.getFileHandle(name);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return null;
      throw err;
    }
    const file = await handle.getFile();
    return file.size === 0 ? null : new Uint8Array(await file.arrayBuffer());
  }

  async writeFile(name: string, data: Uint8Array): Promise<void> {
    assertSafeName(name);
    const handle = (await this.dir.getFileHandle(name, { create: true })) as SyncFileHandle;
    const access = await handle.createSyncAccessHandle();
    try {
      access.truncate(0);
      let offset = 0;
      while (offset < data.length) offset += access.write(data.subarray(offset), { at: offset });
      access.flush();
    } finally {
      access.close();
    }
  }
}

const IDB_NAME = 'budget-vault';
const IDB_STORE = 'files';

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

/** IndexedDB fallback when OPFS is unavailable. */
class IndexedDbStore implements FileVaultStore {
  readonly kind = 'indexeddb';

  private constructor(private readonly db: IDBDatabase) {}

  static async open(): Promise<IndexedDbStore> {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(IDB_STORE);
    };
    return new IndexedDbStore(await idbRequest(request));
  }

  read(slot: VaultSlot): Promise<Uint8Array | null> {
    return this.readFile(slotFile(slot));
  }

  write(slot: VaultSlot, data: Uint8Array): Promise<void> {
    return this.writeFile(slotFile(slot), data);
  }

  async readFile(name: string): Promise<Uint8Array | null> {
    assertSafeName(name);
    const tx = this.db.transaction(IDB_STORE, 'readonly');
    const value: unknown = await idbRequest(tx.objectStore(IDB_STORE).get(name));
    return value instanceof Uint8Array && value.length > 0 ? value : null;
  }

  async writeFile(name: string, data: Uint8Array): Promise<void> {
    assertSafeName(name);
    const tx = this.db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(data.slice(), name);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('IndexedDB write failed'));
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error('IndexedDB write aborted'));
      };
    });
  }
}

async function tryOpfs(): Promise<OpfsStore | null> {
  try {
    if (typeof navigator.storage.getDirectory !== 'function') return null;
    if (typeof FileSystemFileHandle === 'undefined') return null;
    if (!('createSyncAccessHandle' in FileSystemFileHandle.prototype)) return null;
    return new OpfsStore(await navigator.storage.getDirectory());
  } catch {
    return null;
  }
}

/** Opens the vault storage: OPFS when available, otherwise IndexedDB (AD5). */
export async function openVaultStore({ forceIndexedDb = false } = {}): Promise<FileVaultStore> {
  const opfs = forceIndexedDb ? null : await tryOpfs();
  return opfs ?? IndexedDbStore.open();
}
