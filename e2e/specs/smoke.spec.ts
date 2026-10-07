import { expect, test } from '../fixtures/guard.fixture';

test('@smoke loads the app under the production CSP', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Hello Budget' })).toBeVisible();
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).not.toContain('unsafe-inline');
});
