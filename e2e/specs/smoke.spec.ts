import { expect, test } from '../fixtures/guard.fixture';

test('@smoke @security loads under the production CSP without violations (SEC-W02)', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Welcome to Budget' })).toBeVisible();
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toMatch(/'unsafe-eval'/);
});
