import { test as base, expect } from '@playwright/test';

/** Origins the app may contact besides itself. Provider origins are added in Phase 3 (SEC-W12). */
export const ALLOWED_ORIGINS = new Set<string>();

export interface Guard {
  /** Mark console errors matching `pattern` as expected for this test. */
  expectConsoleError(pattern: RegExp): void;
  /** All console messages seen so far (for marker scans, SEC-W05). */
  readonly consoleMessages: string[];
}

/**
 * Global guard (TEST_PLAN §3.3), applied to every test: fails on CSP violations, uncaught page
 * errors, unexpected console errors and requests to non-allow-listed origins.
 */
export const test = base.extend<{ guard: Guard }>({
  guard: [
    async ({ page, context, baseURL }, use) => {
      const problems: string[] = [];
      const expectedErrors: RegExp[] = [];
      const consoleMessages: string[] = [];
      const appOrigin = new URL(baseURL ?? 'http://localhost').origin;

      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (
          url.protocol === 'data:' ||
          url.protocol === 'blob:' ||
          url.origin === appOrigin ||
          ALLOWED_ORIGINS.has(url.origin)
        ) {
          await route.fallback();
          return;
        }
        problems.push(`Request to non-allow-listed origin: ${url.origin}`);
        await route.abort('blockedbyclient');
      });

      await page.exposeFunction('__reportCspViolation', (detail: string) => {
        problems.push(`CSP violation: ${detail}`);
      });
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
          const w = window as unknown as { __reportCspViolation: (d: string) => Promise<void> };
          void w.__reportCspViolation(`${e.violatedDirective} blocked ${e.blockedURI}`);
        });
      });

      page.on('pageerror', (err) => problems.push(`Uncaught page error: ${err.message}`));
      page.on('console', (msg) => {
        const text = msg.text();
        consoleMessages.push(text);
        if (msg.type() === 'error' && !expectedErrors.some((re) => re.test(text))) {
          problems.push(`Unexpected console.error: ${text}`);
        }
      });

      await use({
        expectConsoleError: (pattern) => expectedErrors.push(pattern),
        consoleMessages,
      });

      expect(problems, 'global guard: CSP / page errors / console errors / network').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
