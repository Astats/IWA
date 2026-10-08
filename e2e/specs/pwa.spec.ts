import type { Page } from '@playwright/test';

import { expect, test, TEST_PASSPHRASE } from '../fixtures/app.fixture';
import { TransactionsPage } from '../pages/TransactionsPage';

/** Waits until the service worker is active and controls this page. */
async function waitForServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  }
}

test.describe('PWA', () => {
  test('@smoke J15 offline after the first load: reload, unlock and add a transaction', async ({
    onboardedApp: app,
    page,
    context,
  }) => {
    await waitForServiceWorker(page);

    await context.setOffline(true);
    await page.reload();
    await app.unlock.expectLoaded();
    await app.unlock.unlock(TEST_PASSPHRASE);
    const tx = new TransactionsPage(page);
    await tx.goto();
    await tx.addExpense({ amount: '4.20', category: 'Food', note: 'Offline coffee' });

    await expect(tx.row('Offline coffee')).toBeVisible();
    await app.shell.navigate('Dashboard');
    await expect(page.getByRole('table', { name: 'Expenses by category' })).toBeVisible();
    await context.setOffline(false);
  });

  test('@smoke J16 an update prompt appears when a new service worker is waiting', async ({
    onboardedApp: _app,
    page,
  }) => {
    await waitForServiceWorker(page);
    // Simulate a new deployment: a changed worker script URL installs a second worker, which waits
    // (prompt mode never skips waiting on its own). Playwright cannot route the browser's own
    // service-worker update fetch, so the script URL is changed instead.
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js?next-version', { scope: '/' });
    });

    const prompt = page.getByRole('alert').filter({ hasText: 'A new version is available.' });
    await expect(prompt).toBeVisible({ timeout: 15_000 });
    await prompt.getByRole('button', { name: 'Reload' }).click();
    await expect(page.getByRole('heading', { name: 'Unlock Budget' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('the app is installable (manifest, icons, service worker)', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'installability check uses the Chrome DevTools Protocol');
    await page.goto('/');
    await waitForServiceWorker(page);

    const manifest = (await (await page.request.get('/manifest.webmanifest')).json()) as {
      display: string;
      icons: Array<{ sizes: string; purpose?: string }>;
    };
    const client = await page.context().newCDPSession(page);
    const { installabilityErrors } = (await client.send('Page.getInstallabilityErrors')) as {
      installabilityErrors: Array<{ errorId: string }>;
    };

    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.map((i) => i.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    );
    expect(installabilityErrors.map((e) => e.errorId)).toEqual([]);
  });

  test('@security the service worker precaches only the app shell', async ({ page }) => {
    await page.goto('/');
    await waitForServiceWorker(page);

    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) urls.push(new URL(request.url).pathname);
      }
      return urls;
    });

    expect(cached.length).toBeGreaterThan(0);
    for (const url of cached) {
      expect(url).toMatch(/\.(html|js|css|wasm|svg|png|woff2|webmanifest)$/);
    }
  });
});
