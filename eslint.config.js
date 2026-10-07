// @ts-check
import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import security from 'eslint-plugin-security';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Files that are tests or test tooling (Math.random, test-only imports allowed). */
const TEST_FILES = [
  '**/*.test.{ts,tsx}',
  '**/*.spec.{ts,tsx}',
  '**/test/**/*.{ts,tsx}',
  '**/src/testing/**/*.{ts,tsx}',
  'e2e/**/*.{ts,tsx}',
  'tooling/**/*.{ts,tsx}',
  '**/vitest.setup.ts',
];

/** The only module allowed to touch localStorage/sessionStorage (theme + language prefs). */
const UI_PREFS_FILE = 'apps/web/src/lib/ui-prefs.ts';

const storageMessage =
  'Do not use Web Storage: it is unencrypted. Only apps/web/src/lib/ui-prefs.ts may store theme/language.';

/** @type {Array<{ object?: string; property: string; message: string }>} */
const restrictedProperties = [
  { property: 'innerHTML', message: 'innerHTML is banned (XSS). Use textContent.' },
  { property: 'outerHTML', message: 'outerHTML is banned (XSS).' },
  { property: 'insertAdjacentHTML', message: 'insertAdjacentHTML is banned (XSS).' },
  { object: 'document', property: 'write', message: 'document.write is banned (XSS).' },
  { object: 'document', property: 'writeln', message: 'document.writeln is banned (XSS).' },
  {
    object: 'Math',
    property: 'random',
    message: 'Math.random is banned outside tests. Use crypto.getRandomValues.',
  },
  ...['window', 'globalThis', 'self'].flatMap((object) => [
    { object, property: 'localStorage', message: storageMessage },
    { object, property: 'sessionStorage', message: storageMessage },
  ]),
];
const isStorageRule = (/** @type {{ property: string }} */ r) =>
  r.property === 'localStorage' || r.property === 'sessionStorage';

/** @type {import('eslint').Linter.RulesRecord} */
const securityRules = {
  // OWASP A05 Injection: no HTML/code injection sinks.
  'no-eval': 'error',
  'no-new-func': 'error',
  'no-implied-eval': 'off',
  '@typescript-eslint/no-implied-eval': 'error',
  'no-script-url': 'error',
  'no-restricted-syntax': [
    'error',
    {
      selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
      message: 'dangerouslySetInnerHTML is banned (XSS). Render text instead.',
    },
    {
      selector: "CallExpression[callee.name='Function']",
      message: 'The Function constructor is banned (code injection).',
    },
    {
      selector:
        'CallExpression[callee.name=/^(setTimeout|setInterval)$/][arguments.0.type=/^(Literal|TemplateLiteral)$/]',
      message: 'Passing a string to setTimeout/setInterval is banned (implied eval).',
    },
  ],
  'no-restricted-properties': ['error', ...restrictedProperties],
  'no-restricted-globals': [
    'error',
    { name: 'localStorage', message: storageMessage },
    { name: 'sessionStorage', message: storageMessage },
  ],
};

/**
 * Architecture boundaries (BUILD_PLAN §3).
 * @param {string[]} groups import patterns that are forbidden
 * @param {string} message
 */
const restrictImports = (groups, message) => ({
  'no-restricted-imports': ['error', { patterns: [{ group: groups, message }] }],
});

const TESTING_IMPORT = '@budget/core/testing';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.turbo/**',
      '**/dev-dist/**',
      'apps/web/android/**',
      'apps/web/ios/**',
      // Deliberate violations used by tooling/lint-rules.test.ts; linted only from that test.
      'tooling/lint-fixtures/**',
      '**/*.generated.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      ...securityRules,
      // Reports nearly every `obj[key]`; noUncheckedIndexedAccess + allow-listed keys cover the real risk.
      'security/detect-object-injection': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [TESTING_IMPORT, `${TESTING_IMPORT}/*`],
              message: 'Test builders must never be imported by production code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  // React
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
  // ---- Architecture boundaries ----
  {
    files: ['packages/core/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: restrictImports(
      ['@budget/*', '!@budget/core'],
      'packages/core has no internal dependencies.',
    ),
  },
  {
    files: ['packages/crypto/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: restrictImports(
      [
        '@budget/db',
        '@budget/db/*',
        '@budget/backup',
        '@budget/backup/*',
        '@budget/ui',
        TESTING_IMPORT,
      ],
      'packages/crypto may only depend on @budget/core.',
    ),
  },
  {
    files: ['packages/db/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: restrictImports(
      ['@budget/backup', '@budget/backup/*', '@budget/ui', TESTING_IMPORT],
      'packages/db may only depend on @budget/core and @budget/crypto.',
    ),
  },
  {
    files: ['packages/backup/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: restrictImports(
      ['@budget/db', '@budget/db/*', '@budget/ui', TESTING_IMPORT],
      'packages/backup may only depend on @budget/core and @budget/crypto.',
    ),
  },
  {
    files: ['apps/web/src/features/**/*.{ts,tsx}', 'apps/web/src/components/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: restrictImports(
      ['@budget/db', '@budget/db/*', '@/storage', '@/storage/*', '**/storage/*', TESTING_IMPORT],
      'UI code must use repositories via @budget/core interfaces and the DI provider (@/di), never storage drivers.',
    ),
  },
  // ---- Exceptions ----
  {
    files: [UI_PREFS_FILE],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': [
        'error',
        ...restrictedProperties.filter((r) => !isStorageRule(r)),
      ],
    },
  },
  {
    files: TEST_FILES,
    rules: {
      'no-restricted-properties': [
        'error',
        ...restrictedProperties.filter((r) => r.object !== 'Math'),
      ],
      'no-restricted-imports': 'off',
      // Test files legitimately build paths and read fixtures from disk.
      'security/detect-non-literal-fs-filename': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
