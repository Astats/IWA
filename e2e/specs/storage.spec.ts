import type { Page } from '@playwright/test';

import { expect, test, TEST_PASSPHRASE } from '../fixtures/app.fixture';
import { CategoriesPage } from '../pages/CategoriesPage';

const MARKER = 'MarkerCategory7f3a9c';

/** SEC-W03 scan: every OPFS file and IndexedDB value, searched for plaintext markers. */
async function scanStorage(page: Page, markers: string[]) {
  return page.evaluate(async (needles) => {
    const found: string[] = [];
    let scanned = 0;
    const check = (where: string, bytes: Uint8Array) => {
      scanned += bytes.length;
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      for (const n of needles) if (text.includes(n)) found.push(`${where}: ${n}`);
    };
    const root = await navigator.storage.getDirectory();
    const entries = (
      root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
    ).entries();
    for await (const [name, handle] of entries) {
      if (handle.kind === 'file') {
        const file = await (handle as FileSystemFileHandle).getFile();
        check(`opfs:${name}`, new Uint8Array(await file.arrayBuffer()));
      }
    }
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(info.name!);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('open failed'));
      });
      for (const storeName of db.objectStoreNames) {
        const values = await new Promise<unknown[]>((resolve) => {
          const req = db.transaction(storeName).objectStore(storeName).getAll();
          req.onsuccess = () => resolve(req.result);
        });
        for (const v of values) {
          check(
            `idb:${info.name}`,
            v instanceof Uint8Array ? v : new TextEncoder().encode(JSON.stringify(v)),
          );
        }
      }
      db.close();
    }
    return { found, scanned };
  }, markers);
}

test.describe('encrypted storage (BUILD_PLAN 1.4)', () => {
  test('@smoke @security data survives reload, wrong passphrase reveals nothing, storage holds only ciphertext', async ({
    onboardedApp: app,
    page,
  }) => {
    const categories = new CategoriesPage(page);
    await app.shell.navigate('Categories');
    await categories.create({ name: MARKER, kind: 'income' });

    // 4. OPFS/IndexedDB bytes do not contain the marker in plaintext (SEC-W03).
    const scan = await scanStorage(page, [MARKER, 'Housing', 'CREATE TABLE']);
    expect(scan.scanned).toBeGreaterThan(0);
    expect(scan.found).toEqual([]);

    // 2. Reload and unlock with the right passphrase: data is present.
    await page.reload();
    await app.unlock.expectLoaded();
    // 3. Wrong passphrase: generic error, no data shown.
    await app.unlock.unlock('not the right passphrase');
    await expect(app.unlock.error).toHaveText(
      'Unlock failed. Check your passphrase and try again.',
    );
    await expect(page.getByText(MARKER)).toHaveCount(0);

    await app.unlock.passphrase.fill(TEST_PASSPHRASE);
    await expect(app.unlock.submit).toBeEnabled({ timeout: 5_000 });
    await app.unlock.submit.click();
    await app.shell.navigate('Categories');
    await expect(categories.list('income').getByText(MARKER)).toBeVisible();
  });
});
