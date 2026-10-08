import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const fixtures = path.join(import.meta.dirname, 'lint-fixtures');

// Lint fixtures as if they lived at `virtualPath`, so path-scoped rules (boundaries, ui-prefs exception) apply.
async function lintFixture(fixture: string, virtualPath: string) {
  const eslint = new ESLint({
    cwd: root,
    ignore: false,
    overrideConfig: [{ files: ['**/*.{ts,tsx}'], ...tseslint.configs.disableTypeChecked }],
  });
  const code = readFileSync(path.join(fixtures, fixture), 'utf8');
  const [result] = await eslint.lintText(code, { filePath: path.join(root, virtualPath) });
  return (result?.messages ?? []).filter((m) => m.severity === 2).map((m) => m.ruleId);
}

describe('ESLint security rules', () => {
  it.each([
    ['inner-html.ts', 'no-restricted-properties'],
    ['dangerously-set-inner-html.tsx', 'no-restricted-syntax'],
    ['eval.ts', 'no-eval'],
    ['new-function.ts', 'no-new-func'],
    ['function-call.ts', 'no-new-func'],
    ['set-timeout-string.ts', 'no-restricted-syntax'],
    ['math-random.ts', 'no-restricted-properties'],
    ['local-storage.ts', 'no-restricted-globals'],
    ['session-storage.ts', 'no-restricted-properties'],
  ])('rejects %s with %s', async (fixture, rule) => {
    const errors = await lintFixture(fixture, `apps/web/src/features/${fixture}`);

    expect(errors).toContain(rule);
  });

  it('allows Math.random in test files', async () => {
    const errors = await lintFixture('math-random.ts', 'packages/core/src/money.test.ts');

    expect(errors).not.toContain('no-restricted-properties');
  });

  it('allows localStorage only in ui-prefs.ts', async () => {
    const errors = await lintFixture('local-storage.ts', 'apps/web/src/lib/ui-prefs.ts');

    expect(errors).toEqual([]);
  });
});

describe('ESLint architecture boundaries', () => {
  it('rejects UI features importing the db package', async () => {
    const errors = await lintFixture(
      'apps/web/src/features/imports-db.ts',
      'apps/web/src/features/transactions/x.ts',
    );

    expect(errors).toContain('no-restricted-imports');
  });

  it('rejects core importing another internal package', async () => {
    const errors = await lintFixture(
      'packages/core/src/imports-crypto.ts',
      'packages/core/src/x.ts',
    );

    expect(errors).toContain('no-restricted-imports');
  });

  it.each(['apps/web/src/app/browser-services.ts', 'apps/web/src/features/backup/x.ts'])(
    'rejects the fake cloud provider in production code (%s)',
    async (virtualPath) => {
      const errors = await lintFixture('imports-fake-provider.ts', virtualPath);

      expect(errors).toContain('no-restricted-imports');
    },
  );

  it('allows the fake cloud provider only in the e2e hook module', async () => {
    const errors = await lintFixture('imports-fake-provider.ts', 'apps/web/src/app/e2e-hooks.ts');

    expect(errors).not.toContain('no-restricted-imports');
  });

  it('allows db importing crypto', async () => {
    const errors = await lintFixture('packages/core/src/imports-crypto.ts', 'packages/db/src/x.ts');

    expect(errors).not.toContain('no-restricted-imports');
  });
});
