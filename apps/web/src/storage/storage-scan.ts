/**
 * SEC-W03 scan helper: reads every file in OPFS and every value in the app's IndexedDB databases
 * and reports which marker strings appear in plaintext. Used by browser-mode and e2e tests.
 * (Pure read-only inspection; never shipped as a code path the app calls.)
 */
export interface ScanResult {
  scannedBytes: number;
  matches: Array<{ location: string; marker: string }>;
}

function containsMarker(bytes: Uint8Array, marker: string): boolean {
  const needle = new TextEncoder().encode(marker);
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function idbValues(name: string): Promise<Uint8Array[]> {
  return new Promise((resolve) => {
    const open = indexedDB.open(name);
    open.onerror = () => {
      resolve([]);
    };
    open.onsuccess = () => {
      const db = open.result;
      const stores = [...db.objectStoreNames];
      if (stores.length === 0) {
        db.close();
        resolve([]);
        return;
      }
      const tx = db.transaction(stores, 'readonly');
      const out: Uint8Array[] = [];
      for (const s of stores) {
        const req = tx.objectStore(s).getAll();
        req.onsuccess = () => {
          for (const v of req.result) {
            if (v instanceof Uint8Array) out.push(v);
            else out.push(new TextEncoder().encode(JSON.stringify(v)));
          }
        };
      }
      tx.oncomplete = () => {
        db.close();
        resolve(out);
      };
    };
  });
}

export async function scanStorageForPlaintext(markers: string[]): Promise<ScanResult> {
  const result: ScanResult = { scannedBytes: 0, matches: [] };
  const check = (location: string, bytes: Uint8Array) => {
    result.scannedBytes += bytes.length;
    for (const marker of markers)
      if (containsMarker(bytes, marker)) result.matches.push({ location, marker });
  };
  const root = await navigator.storage.getDirectory();
  for await (const [name, handle] of (
    root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
  ).entries()) {
    if (handle.kind === 'file') {
      check(
        `opfs:${name}`,
        new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer()),
      );
    }
  }
  for (const info of await indexedDB.databases()) {
    if (!info.name) continue;
    for (const value of await idbValues(info.name)) check(`idb:${info.name}`, value);
  }
  return result;
}
