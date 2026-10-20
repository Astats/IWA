# Budget App — Test Plan for AI Coding Agents

> **Companion to [BUILD_PLAN.md](BUILD_PLAN.md).** BUILD_PLAN says *what* to build; this file says *how to test it*.
> Every step in BUILD_PLAN is "done" only when the tests required here for that step exist and pass (see [section 10](#10-tests-required-per-build-step)).
> If this file and BUILD_PLAN conflict, stop and ask the human.

---

## 0. Rules for the agent

1. **Test first where it pays off.** For domain logic, money, crypto, CSV, backup formats and every bug fix, write the failing test *before* the implementation (red → green → refactor).
2. **Every bug fix starts with a regression test** that reproduces the bug. Name it after the bug: `it('regression: CSV import accepted negative amount (#12)')`.
3. **Test behavior, not implementation.** Assert on public APIs, rendered output and stored data. Don't assert on private functions, internal state or component instance methods.
4. **Tests are deterministic.** No real network, no real clock, no unseeded randomness, no dependence on test order, no `sleep` / `waitForTimeout`. Use fake timers, seeded data and web-first assertions.
5. **No test backdoors in production code.** Test-only hooks live behind `import.meta.env.MODE === 'e2e'` and must be tree-shaken from production builds. A CI check proves it ([section 7.4](#74-build-integrity-checks)).
6. **Never weaken security to make a test pass** (e.g. relaxing the CSP, disabling encryption or skipping validation). Make the test environment satisfy the security rules instead.
7. **Keep the suite fast.** Targets: unit + component < 60 s, PR e2e (Chromium) < 8 min. If a test is slow, move it down the pyramid or optimize it. Don't delete it.
8. **Flaky tests are bugs.** See the [flaky test policy](#93-flaky-test-policy).

---

## 1. Test strategy overview

### 1.1 Test pyramid

```
                 ┌──────────────────────────┐
                 │  Manual / exploratory    │  per milestone (checklists, section 8)
                 ├──────────────────────────┤
                 │  Mobile E2E (Appium)     │  smoke only (Phase 4)
                 ├──────────────────────────┤
                 │  Web E2E (Playwright)    │  critical user journeys, security, a11y
               ┌─┴──────────────────────────┴─┐
               │  Integration                 │  repositories on real SQLite, storage worker in a
               │                              │  real browser, server + real Postgres, provider adapters
             ┌─┴──────────────────────────────┴─┐
             │  Component (Vitest + RTL)         │  screens/forms with in-memory repositories + MSW
           ┌─┴──────────────────────────────────┴─┐
           │  Unit (Vitest)                        │  core, crypto, csv, backup, money, utils
         ┌─┴──────────────────────────────────────┴─┐
         │  Static (tsc strict, ESLint, Semgrep)     │  every commit
         └───────────────────────────────────────────┘
```

Rough proportion by count: ~70% unit, ~20% component + integration, ~10% e2e.

### 1.2 Test levels

| Level | Tool | Environment | Scope | Runs |
|---|---|---|---|---|
| L0 Static | `tsc --noEmit`, ESLint, Semgrep, gitleaks | Node | Types, lint rules, SAST, secrets | every commit / PR |
| L1 Unit | Vitest | Node | Pure functions and classes in `packages/*` | every commit / PR |
| L2 Component | Vitest + React Testing Library + `user-event` + MSW | jsdom | React components, forms, hooks, routing guards | PR |
| L3a Integration (DB) | Vitest | Node + sqlite-wasm | Repository **contract suite** against real SQLite | PR |
| L3b Integration (browser) | **Vitest Browser Mode** (Playwright provider) | real Chromium / Firefox / WebKit | Web Worker, OPFS, IndexedDB fallback, WASM under CSP | PR (Chromium), nightly (all) |
| L3c Integration (server) | Vitest + `fastify.inject` + **Testcontainers** (Postgres) | Node + Docker | API routes, auth, multi-tenancy, sync | PR (Phase 5) |
| L4 E2E web | Playwright Test | Chromium, Firefox, WebKit + mobile viewports | User journeys on the built app (`vite preview`) | PR (Chromium, sharded), nightly (matrix) |
| L5 Non-functional | axe-core, Lighthouse CI, size-limit, Playwright perf marks, `toHaveScreenshot` | Browser | Accessibility, performance budgets, bundle size, visual regression | PR (a11y, size), nightly (rest) |
| L6 Security | Section 6 test cases, ZAP, fast-check fuzzing, Trivy, OSV-Scanner, MobSF | Mixed | OWASP ASVS / MASVS verification | PR + nightly + release |
| L7 Mobile | WebdriverIO + Appium (Android emulator), MobSF | Android emulator + physical device | Native storage, lock, share, OAuth deep link | nightly + release (Phase 4) |
| L8 Mutation | StrykerJS | Node | Test-suite quality for `core`, `crypto`, CSV, backup | nightly / weekly |
| L9 Manual | Checklists in section 8 | Real devices | Exploratory, UAT, MASVS manual items | each milestone |

---

## 2. Conventions

### 2.1 File locations and naming
| Kind | Location | Pattern |
|---|---|---|
| Unit | next to the source | `src/**/foo.test.ts` |
| Component | next to the component | `src/**/Foo.test.tsx` |
| Browser-mode integration | next to the source | `src/**/foo.browser.test.ts` |
| Repository contract suite | `packages/db/test/contract/` | `*.contract.ts` (exported, reused by every driver) |
| Server integration | `apps/server/test/` | `*.int.test.ts` |
| E2E | `/e2e/specs/` | `<feature>.spec.ts` |
| E2E page objects | `/e2e/pages/` | `<Screen>Page.ts` |
| E2E fixtures (Playwright) | `/e2e/fixtures/` | `*.fixture.ts` |
| Static test files (CSV, backups) | `/test-data/` | `csv/*.csv`, `backup/v<N>/*.bgtb` |
| Test data builders | `packages/core/src/testing/` | exported via subpath `@budget/core/testing` (never imported by production code; enforced by lint) |
| Mobile E2E | `/e2e-mobile/specs/` | `*.e2e.ts` |

### 2.2 Writing style
- Use the **Arrange–Act–Assert** structure, separated by blank lines.
- **Describe behavior:** `describe('parseAmount')` → `it('rejects more decimals than the currency allows')`.
- **One logical behavior per test.** Several `expect`s are fine if they verify the same behavior.
- Use **table-driven tests** (`it.each`) for input/output matrices (money, CSV fields, validation rules).
- **No snapshot tests of whole components.** Inline snapshots are allowed for small, stable serialized output (e.g. a generated CSV line, a problem+json body).
- **Explicit test data:** values that matter to the assertion are visible in the test. Builders supply the rest.

### 2.3 Locators and queries (component and E2E)
Priority order (Testing Library / Playwright best practice):
1. `getByRole(role, { name })`
2. `getByLabel`
3. `getByPlaceholder` / `getByText`
4. `getByTestId`: last resort, only for non-semantic elements (e.g. chart canvas)

**Banned:** CSS / XPath selectors tied to styling classes, `nth-child` chains, and `waitForTimeout`.
Accessible locators double as accessibility checks: if an element can't be found by role and name, fix the markup.

### 2.4 Test data
- **Builders** in `@budget/core/testing`:
  - `aTransaction(overrides?)`, `aCategory(overrides?)`, `aBackupPayload(overrides?)`
  - `seedLedger(repo, { count, seed, dateRange, currencies })` for bulk data
  - Built on `@faker-js/faker` with a **fixed seed** per test file (`faker.seed(12345)`). Print the seed on failure.
- **Fixed clock:** `vi.useFakeTimers({ now: new Date('2026-03-15T10:00:00Z') })` in unit/component tests; `page.clock.install({ time: ... })` in Playwright.
- **Golden files** (`/test-data/backup/v<N>/`): one committed backup file per backup `format_version` and per DB `schema_version`, each with a known passphrase and the expected decoded JSON. These must keep restoring successfully forever (backward-compatibility guarantee). Never edit a golden file; add new ones.
- **CSV fixtures** (`/test-data/csv/`): see the list in Step 2.2 of [section 10](#10-tests-required-per-build-step).
- **No real personal data** in fixtures, ever.

### 2.5 Crypto cost in tests
- KDF parameters are **injected**, not hard-coded. Unit and component tests use fast parameters (`m=1 MiB, t=1`) via `testKdfParams` from `@budget/core/testing`.
- **Exactly one test per runtime** (Node unit, browser integration) uses the production parameters. It asserts that unlock takes ≥ 200 ms and ≤ 2 s on CI hardware.
- **E2E runs the production build with production parameters.** It does not use test parameters, so the real crypto path is exercised.

---

## 3. Tooling and configuration

### 3.1 Packages (dev dependencies)
| Purpose | Package |
|---|---|
| Test runner | `vitest`, `@vitest/coverage-v8`, Vitest Browser Mode with the Playwright provider (check the current package name in the Vitest docs) |
| DOM | `jsdom` |
| React testing | `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom` |
| HTTP mocking | `msw` (Mock Service Worker). Used for the Microsoft Graph, Google Drive, Dropbox and own-API mocks |
| Property-based / fuzz | `fast-check` (+ `@fast-check/vitest`) |
| Test data | `@faker-js/faker` |
| IndexedDB in Node | `fake-indexeddb` |
| E2E | `@playwright/test` |
| Accessibility | `@axe-core/playwright`, `vitest-axe` (component level) |
| Mutation | `@stryker-mutator/core`, `@stryker-mutator/vitest-runner` |
| Bundle size | `size-limit` + `@size-limit/preset-app` |
| Performance | `@lhci/cli` (Lighthouse CI) |
| Server integration | `testcontainers` (`@testcontainers/postgresql`) |
| Mobile E2E | `webdriverio`, `@wdio/cli`, `appium`, `appium-uiautomator2-driver` |
| Security scanning | OWASP ZAP (Docker image `zaproxy/zap-stable`), Trivy, OSV-Scanner, Semgrep, gitleaks, MobSF (Docker) |

### 3.2 Vitest setup
- A root `vitest.config.ts` uses **projects**: `core`, `crypto`, `db`, `backup` (Node env), `web-unit` (jsdom), `web-browser` (browser mode), and `server` (Node).
- Settings:
  - `restoreMocks: true`, `unstubGlobals: true`, `unstubEnvs: true`
  - `sequence.shuffle: true` on CI (to detect order dependence; the seed is printed)
- Shared setup files:
  - `jest-dom` matchers and an MSW server with `onUnhandledRequest: 'error'` (any unmocked network call fails the test)
  - `crypto.subtle` from Node's `globalThis.crypto`
  - **a console guard**: any `console.error` / `console.warn` not explicitly expected fails the test
- **Coverage** with the v8 provider; thresholds enforced per package:

| Package / area | Lines | Branches |
|---|---|---|
| `packages/core` | 95% | 90% |
| `packages/crypto` | 95% | 90% |
| `packages/backup` | 90% | 85% |
| `packages/db` | 90% | 85% |
| CSV import/export modules | 95% | 90% |
| `apps/web` | 75% | 65% |
| `apps/server` | 85% | 80% |

  Coverage is a floor, not a goal. Mutation score ([section 5.3](#53-mutation-testing)) measures test quality.

### 3.3 Playwright setup
- `webServer`: `pnpm --filter web build && pnpm --filter web preview --port 4173` (tests run against the **production build**, including the CSP).
- Projects:

| Project | Device | PR | Nightly |
|---|---|---|---|
| `chromium` | Desktop Chrome | ✅ (sharded ×2) | ✅ |
| `firefox` | Desktop Firefox | | ✅ |
| `webkit` | Desktop Safari | | ✅ |
| `mobile-chrome` | Pixel 7 | | ✅ |
| `mobile-safari` | iPhone 15 | | ✅ |

- Settings:
  - `fullyParallel: true`, `forbidOnly: !!process.env.CI`, `retries: process.env.CI ? 2 : 0`
  - `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`, `video: 'retain-on-failure'`
  - reporters: `html`, `junit` and `github`
- **Global guard fixture**, applied to every test automatically (`{ auto: true }`). It fails the test if:
  - any `securitypolicyviolation` event fires (CSP)
  - any uncaught page error occurs
  - any `console.error` occurs that the test did not expect
  - any request goes to an origin that is not allow-listed (route interception)
- **Each test gets a fresh browser context**, which means empty OPFS/IndexedDB. Tests never share app data.
- **Page Object Model** in `/e2e/pages/`: `OnboardingPage`, `UnlockPage`, `DashboardPage`, `TransactionsPage`, `TransactionFormPage`, `CategoriesPage`, `ImportExportPage`, `BackupPage`, `SettingsPage`. Page objects expose user-level actions (`addExpense({ amount, category, date, note })`) and locators. They don't make assertions, except for small `expectLoaded()` helpers.
- Custom fixtures:
  - `onboardedApp`: completes onboarding through the UI with a known test passphrase and returns page objects
  - `seededApp(n)`: onboarded, then imports a generated CSV of `n` rows through the UI. This makes seeding go through the real import path, with no backdoor.
  - `fakeProviders`: MSW-in-browser or `page.route` mocks for OneDrive, Google Drive and Dropbox, simulating OAuth popups and redirects and file APIs
- Use `page.clock` for auto-lock and backup-reminder tests.
- **Visual regression** with `toHaveScreenshot`: only on `chromium`, only for key screens (dashboard, list, form, onboarding) in light and dark themes, run inside the **official Playwright Docker image** so rendering is stable. Mask dynamic regions (dates).

### 3.4 Scripts (root `package.json`)
```
test              → vitest run                        (all unit/component/integration projects)
test:watch        → vitest
test:coverage     → vitest run --coverage
test:browser      → vitest run --project web-browser
test:e2e          → playwright test --project=chromium
test:e2e:all      → playwright test
test:e2e:ui       → playwright test --ui
test:a11y         → playwright test --grep @a11y
test:security     → playwright test --grep @security && vitest run --project security
test:visual       → playwright test --grep @visual
test:mutation     → stryker run
test:mobile       → wdio run e2e-mobile/wdio.conf.ts
test:server       → vitest run --project server        (needs Docker)
size              → size-limit
lhci              → lhci autorun
```
Tags used in Playwright test titles: `@smoke`, `@a11y`, `@security`, `@visual`, `@perf`, `@slow`.

---

## 4. What to test, per area

### 4.1 `packages/core` (domain, money, validation)
- **Money:**
  - Table-driven tests for currencies with 0, 2 and 3 decimals (JPY, EUR, KWD)
  - Locale formats (`en-US` `1,234.56`; `de-DE` `1.234,56`; `fr-FR` `1 234,56` with narrow no-break space; `lv-LV`)
  - Maximum amount boundary (10^13), zero (rejected), negative (rejected), `NaN`/`Infinity`/empty/whitespace (rejected), scientific notation (rejected)
- **Property-based (fast-check):**
  - `parse(format(x)) === x` for every valid `amount_minor` and currency
  - `sum` is associative and commutative
  - Totals never lose precision for up to 100,000 items
- **Zod schemas:** every rule from BUILD_PLAN §4.1 has an accept case *and* a reject case. Unknown keys are stripped. Strings are trimmed. A category-kind mismatch is rejected.
- **Date presets:** month boundaries, leap years, year rollover, DST transitions in `Europe/Riga` and `America/New_York` (set via the `TZ` env in a dedicated Vitest project).

### 4.2 `packages/crypto`
- Round-trip encrypt/decrypt for empty, 1-byte and 10 MB payloads.
- **Negative tests:** wrong passphrase, wrong key, flipped bit in IV / ciphertext / tag / AAD header, truncated blob and wrong magic each produce a typed error (`DecryptionError`, `FormatError`). No partial plaintext is ever returned.
- **IV uniqueness:** 10,000 encryptions with the same key give no duplicate IVs.
- **Key properties:** the unwrapped DEK is `extractable: false`; `exportKey` on it rejects.
- **Envelope:** changing the passphrase re-wraps the DEK. Old passphrase fails, new one works, data is unchanged.
- **Vault A/B slots:** the newest slot is corrupted → the previous generation loads. Both slots are corrupted → a typed error and no data loss in storage (nothing gets overwritten).
- **KDF parameter guard:** the vault header cannot request parameters below the minimum (a downgrade attack) → rejected.
- **Known-answer tests:** fixed Argon2id test vectors (from the RFC 9106 / reference implementation) to detect library regressions.

### 4.3 `packages/db` — repository contract suite
- A single exported suite, `runRepositoryContract(name, makeDriver)`, is executed against **every** `SqlDriver`:
  - the Node sqlite-wasm driver (L3a, PR)
  - `WorkerSqlDriver` in browser mode (L3b)
  - `NativeSqlDriver` on the Android emulator (L7, Phase 4)
  - the PostgreSQL server repositories (L3c, Phase 5)

  This guarantees that every backend behaves the same way.
- The contract covers:
  - CRUD and soft delete/restore
  - every sort key × direction
  - every filter alone and combined
  - pagination edges (offset beyond total, limit max 500)
  - `totals` / `byCategory` against independently computed expected values (computed in the test with plain BigInt sums, not via the code under test)
  - `bulkInsert` atomicity (one invalid row → zero rows inserted)
  - blocking deletion of a category that is in use
  - `updated_at` monotonicity
  - `deleted_at` exclusion
- **Injection:** search strings `%`, `_`, `'`, `"; DROP TABLE transactions; --`, `%' OR 1=1 --` and Unicode/emoji are matched literally.
- **Migrations:**
  - Fresh install → latest version.
  - Upgrade from **each previous schema version** (golden DB fixtures) → latest, with data preserved.
  - A failing migration rolls back fully.
  - The schema-parity test (SQLite vs Postgres columns) runs in Phase 5.

### 4.4 CSV import/export
- **Export:**
  - RFC 4180 quoting (commas, quotes, CR/LF in notes)
  - BOM present
  - Formula-injection escaping for every leading char `= + - @ \t \r`, including after leading whitespace
  - Non-ASCII text (`ā č ē ģ ī ķ ļ ņ š ū ž`, CJK, emoji)
- **Import:**
  - Delimiter detection `,` / `;`, decimal comma, with and without BOM, CRLF and LF line endings
  - Header case-insensitivity, missing or extra columns, empty file, header only
  - Per-row error collection (row number + field + message), duplicates by id and by tuple, creation of new categories
  - Size limits: 5 MB, 50,000 rows and 500 chars per field are rejected **before** full parsing when possible
- **Property-based:** for any valid list of transactions, `import(export(list))` deep-equals `list`.
- **Fuzz (fast-check):** random byte strings and random CSV-like strings never throw unhandled errors, never hang (> 2 s), and never insert anything when validation fails.

### 4.5 Backup (`packages/backup`)
- Round-trip, wrong passphrase, tampered header and body, truncated file, gzip bomb guard (decompressed size limit enforced), and a future `format_version` rejected with a clear message.
- **Golden files:** every file in `/test-data/backup/v*/` restores and matches its expected JSON.
- **Restore modes:**
  - *Replace* creates a pre-restore backup first.
  - *Merge* resolves conflicts by newest `updated_at`; tombstones win over older edits.
- **Provider adapters** (OneDrive, Google Drive, Dropbox), tested with **MSW**:
  - success paths, pagination of `list()`, chunked/resumable upload for files over 4 MB
  - 401 → re-auth prompt; 403/404/409/429/5xx → retry with backoff where idempotent, otherwise a typed error
  - network drop mid-upload → no partial file left as "latest"
  - retention keeps the last N backups
- **OAuth helpers:**
  - PKCE verifier/challenge are correct (S256 test vector from RFC 7636)
  - `state` mismatch → rejected
  - tokens never written to `localStorage` / `sessionStorage` / IndexedDB (asserted with storage spies)

### 4.6 `apps/web` components (L2)
- Use **in-memory repository fakes** (`InMemoryTransactionRepository` in `@budget/core/testing`; they also pass the contract suite) and inject them via the `RepositoryProvider`.
- **Forms:** validation messages appear on blur/submit, focus moves to the first invalid field, submit is disabled while pending, and server/repository errors are shown generically.
- **Route guards:** no vault → onboarding; locked → unlock; unlocked → requested route.
- **Auto-lock** (fake timers):
  - inactivity for N minutes → lock screen
  - the query cache is cleared and no transaction text remains in the DOM
  - user activity resets the timer
- **i18n:** render each screen with a pseudo-locale (e.g. `en-XA`, which wraps strings in brackets) and assert that no un-translated literal strings appear.
- **A11y:** `vitest-axe` on each form and dialog component.

### 4.7 Storage worker in a real browser (L3b, Vitest Browser Mode)
- Create a vault → write → reload worker → unlock → data present.
- **OPFS bytes contain no plaintext:** search for a unique marker note string.
- Debounced persistence: 20 writes in 100 ms → at most 2 file writes. A flush happens on `lock()` and on `visibilitychange`.
- **IndexedDB fallback path:** force OPFS unavailable and the same scenarios pass.
- **Crash safety:** abort the worker mid-write (terminate) → the next unlock loads the previous generation.
- sqlite-wasm loads under the production CSP (`wasm-unsafe-eval` only).
- Runs on Chromium in PR; Firefox and WebKit nightly.

### 4.8 Server (Phase 5, L3c)
- `fastify.inject` for routing, validation and error format (RFC 9457 problem+json, no stack traces, no internal messages).
- Real Postgres via Testcontainers. Migrations run once per test run; each test runs in a transaction that is rolled back, or uses a per-test schema.
- **AuthZ matrix test** (generated): for every endpoint × {anonymous, user A, user B} → expected status. User B can never read or modify A's resources (IDOR), including through sync pull/push.
- **Mass assignment:** extra fields such as `user_id` or `server_version` in request bodies are ignored or stripped.
- **Session:**
  - cookie flags (`HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-`)
  - idle and absolute timeouts (fake clock)
  - logout invalidates the session server-side
  - session ID rotates on login (fixation)
- **CSRF:** state-changing requests without a valid token are rejected.
- **Rate limiting:** limits on auth and sync endpoints return 429 with `Retry-After`.
- **Security headers** are present on every response (snapshot of the header set).
- **Logging:** a test captures pino output and asserts that redacted fields (`authorization`, `cookie`, `note`, `amount_minor`) never appear.
- **Sync:**
  - two clients edit offline → last-write-wins
  - delete vs edit
  - idempotent push retry (same batch twice → no duplicates)
  - pull pagination
  - clock-skewed client timestamps
- **OIDC:** use a mock OIDC provider (e.g. `oauth2-mock-server`) to test valid login and invalid `iss` / `aud` / signature / expired tokens.

---

## 5. E2E test suite (L4)

### 5.1 Critical user journeys (all tagged `@smoke` → run on every PR)
| ID | Journey |
|---|---|
| J1 | First run: onboarding (passphrase policy feedback, acknowledgement, currency, language) → dashboard shows zero totals and default categories |
| J2 | Add income + add expense → dashboard totals and chart update → list shows both |
| J3 | Edit a transaction (amount, category, date) → totals recalculate |
| J4 | Delete → Undo restores → delete again → gone from list and totals |
| J5 | Sort by each column (asc/desc) and filter by kind, category, date range and search; the filter state survives a reload via the URL, and the search term does **not** appear in the URL |
| J6 | Categories: create, rename, recolor, delete-blocked → reassign → delete |
| J7 | Lock manually → unlock with a wrong passphrase (generic error, progressive delay) → correct passphrase → data intact |
| J8 | Auto-lock after inactivity (`page.clock`) → data removed from the DOM |
| J9 | Reload / close and reopen → unlock → all data persisted |
| J10 | CSV export → re-import into a fresh context → identical list and totals |
| J11 | CSV import with errors → preview shows counts and errors → error CSV downloadable → commit valid rows only if the user chooses; all-or-nothing behavior respected |
| J12 | Local backup download → restore into a fresh context (replace) → identical data; merge mode resolves conflicts |
| J13 | Cloud backup with each faked provider: connect → back up → list → restore → delete → disconnect |
| J14 | Change passphrase → lock → old passphrase fails, new one works |
| J15 | Offline: go offline after the first load → reload → unlock → add a transaction → still works (PWA) |
| J16 | App update prompt appears when a new service worker is waiting (simulated) |
| J17 | Settings: language switch changes formats; theme switch; base currency for new transactions |

### 5.2 Performance tests (`@perf`, nightly; also on PR when touching `db`/`storage`/list code)
| Metric | Budget |
|---|---|
| Unlock (production KDF) on CI runner | ≤ 2.0 s |
| Transactions list, first page with 10,000 rows | ≤ 300 ms after navigation |
| Sort/filter change with 10,000 rows | ≤ 200 ms |
| CSV import of 50,000 rows (valid) | ≤ 10 s, UI stays responsive (no long task > 200 ms on the main thread) |
| Persist after write (debounced flush complete) with 10,000 rows | ≤ 1 s |
| Initial JS (gzipped, excluding the sqlite WASM) | ≤ 250 KB, enforced by `size-limit` on every PR |
| Lighthouse (mobile preset) | Performance ≥ 90, Accessibility = 100, Best Practices ≥ 95; PWA installable |

Measure with `performance.mark`/`measure` exposed in the e2e build mode and read via `page.evaluate`. Log results to the CI summary and fail when a budget is exceeded.

### 5.3 Mutation testing
- **StrykerJS** on `packages/core`, `packages/crypto`, CSV modules and `packages/backup`.
- Minimum mutation score is **80%** (fail nightly below that). Surviving mutants in money or crypto code must be killed or justified in a comment.

---

## 6. Security test plan (OWASP)

Every case is an automated test unless marked **(M)** for manual. Tag automated web cases `@security`.
IDs are referenced in commit messages and in the release checklist.

### 6.1 Web client (OWASP ASVS 5.0 L2 / Top 10 2025)
| ID | Test | Level | Maps to |
|---|---|---|---|
| SEC-W01 | XSS payloads (`<img src=x onerror=alert(1)>`, `<script>`, `javascript:` URLs, SVG payloads) in note, category name, CSV fields and backup JSON are rendered as literal text. No dialog appears, and the DOM contains no injected elements. | E2E + component | A05, ASVS V1 |
| SEC-W02 | CSP is present in the production build. No `unsafe-inline` or `unsafe-eval`. The global guard sees zero violations during the whole suite. | E2E | A02 |
| SEC-W03 | After every journey, `localStorage` / `sessionStorage` contain only the allow-listed UI prefs keys. IndexedDB/OPFS contain only ciphertext (marker-string scan). | E2E | A04 |
| SEC-W04 | URLs (history entries) never contain notes, amounts, search terms or tokens. | E2E | A04 |
| SEC-W05 | Console output during the full suite contains no transaction notes, amounts or tokens (marker scan of captured console). | E2E | A09 |
| SEC-W06 | Wrong passphrase → generic error. Progressive delay grows after repeated failures. Nothing is decrypted. | E2E + unit | A07 |
| SEC-W07 | Passphrase policy: < 12 chars rejected; common passwords rejected; long Unicode passphrases accepted. | Component | ASVS V6 |
| SEC-W08 | Auto-lock and manual lock drop the key. After locking, no financial data remains in the DOM, the React Query cache or worker memory references (worker reports a locked state). | Component + E2E | A07 |
| SEC-W09 | Tampered vault or backup → fail closed with a typed error. No partial import. | Unit + E2E | A08, A10 |
| SEC-W10 | CSV formula injection: exported cells are escaped (verify by parsing the exported file). | Unit + E2E | A05 |
| SEC-W11 | Oversized CSV (> 5 MB / > 50k rows / long fields) and backup bombs (decompressed > limit) are rejected without freezing the UI. | Unit + E2E | A10, A06 |
| SEC-W12 | Network allow-list: during the full E2E suite, requests go only to `self` and the mocked provider origins. Any other origin fails the test. | E2E | A03, A05 |
| SEC-W13 | OAuth: PKCE S256 used; `state` mismatch rejected; only minimal scopes requested (assert the authorize URL); tokens kept in memory only (web). | Unit + E2E | A07, A01 |
| SEC-W14 | No test hooks or e2e markers exist in the production bundle ([section 7.4](#74-build-integrity-checks)). | CI script | A08 |
| SEC-W15 | Clickjacking: in production behind Caddy, `frame-ancestors 'none'` is in the HTTP header (ZAP/header test); the local phase notes that a meta-tag CSP can't set it. | Phase 5 | A02 |
| SEC-W16 | Dependency and supply-chain checks (`pnpm audit`, OSV-Scanner, lockfile integrity via `pnpm install --frozen-lockfile`) and SBOM generation succeed. | CI | A03 |
| SEC-W17 **(M)** | Exploratory: try to break unlock, import and restore with crafted files; review DevTools storage, memory snapshot after lock, and the service worker cache contents. | Manual | ASVS |
| SEC-W18 | Cloud provider responses are untrusted: listings are Zod-validated and anything that is not a well-formed `budget-backup-*.bgtb` entry is ignored; downloaded files pass the same fail-closed checks as local backups; provider errors are shown as generic translated messages. | Unit + component | A08, A10 |

### 6.2 Server / API (Phase 5)
| ID | Test | Maps to |
|---|---|---|
| SEC-S01 | AuthZ matrix: every endpoint × role, IDOR on every resource ID | A01 |
| SEC-S02 | AuthN: missing, expired or invalid-signature tokens, wrong `aud`/`iss`, and `alg: none` are rejected | A07 |
| SEC-S03 | Session cookie flags, rotation, idle/absolute timeout, logout invalidation | A07 |
| SEC-S04 | CSRF on all state-changing cookie-authenticated routes | A01 |
| SEC-S05 | Input validation: oversized bodies (413), wrong content type (415), unknown fields stripped, SQL-meta characters stored literally | A05 |
| SEC-S06 | Rate limiting on auth/sync; 429 with `Retry-After` | A07, A06 |
| SEC-S07 | Errors: problem+json, no stack traces or SQL errors leaked (forced DB failure test) | A10 |
| SEC-S08 | Security headers on all responses (HSTS, CSP, nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP) | A02 |
| SEC-S09 | Log redaction (captured pino output) | A09 |
| SEC-S10 | Audit events written for login, logout, failed login and data export | A09 |
| SEC-S11 | CORS: only the configured origin is allowed; credentials are not allowed for others | A02 |
| SEC-S12 | **OWASP ZAP baseline** (PR, passive) and **ZAP full/API scan** with the OpenAPI spec (nightly) against `docker compose up`: zero High, Medium alerts triaged | A02, A05 |
| SEC-S13 | **Trivy**: image and IaC scans with no Critical findings; High findings triaged | A03, A02 |
| SEC-S14 | Container runs as non-root with a read-only filesystem (asserted via `docker inspect` in CI) | A02 |

### 6.3 Mobile (OWASP MASVS / MASTG, Phase 4)
| ID | Test | MASVS |
|---|---|---|
| SEC-M01 | DB file pulled from the emulator (`adb`) is not readable by `sqlite3` (SQLCipher active) | STORAGE |
| SEC-M02 | No sensitive data in app logs (`adb logcat` scan during the mobile smoke run) | STORAGE |
| SEC-M03 | Keys are in the Android Keystore. Shared preferences contain no secrets. | CRYPTO, STORAGE |
| SEC-M04 | App locks on background; biometric fallback to passphrase; `FLAG_SECURE` set (screenshot attempt returns blank) | AUTH, PLATFORM |
| SEC-M05 | OAuth through the system browser (Custom Tabs / ASWebAuthenticationSession) with PKCE and `state`; deep link from a non-matching `state` is rejected | AUTH, PLATFORM |
| SEC-M06 | `usesCleartextTraffic=false`, no exported components except the launcher and the deep-link activity | NETWORK, PLATFORM |
| SEC-M07 | **MobSF** static scan of the release APK: no High findings left untriaged | CODE, RESILIENCE |
| SEC-M08 | Release build: WebView debugging disabled, no source maps shipped, minified | CODE |
| SEC-M09 **(M)** | MASTG manual checks on a physical device (backup extraction with `adb backup` / iTunes, clipboard, app switcher snapshot) | All |

---

## 7. CI/CD pipelines

### 7.1 Pull request pipeline (must pass to merge)
1. Install with `--frozen-lockfile`, using the pnpm store cache.
2. **Static:** `typecheck`, `lint`, `format:check`, Semgrep, gitleaks.
3. **Unit + component + DB integration:** `vitest run --coverage` (thresholds enforced) with shuffle on.
4. **Browser integration:** `vitest --project web-browser` on Chromium.
5. **Build** the production web app, then run `size-limit` and the build-integrity checks ([section 7.4](#74-build-integrity-checks)).
6. **E2E** `@smoke` + `@security` + `@a11y` on Chromium, sharded ×2, against the production build.
7. **Server** (Phase 5): Testcontainers integration and the ZAP baseline against docker-compose.
8. **Supply chain:** `pnpm audit --prod --audit-level high`, OSV-Scanner.
9. **Artifacts:** JUnit, coverage report, Playwright HTML report + traces (on failure), and a summary of perf numbers.

Turborepo affected-filtering (`--filter=...[origin/main]`) may skip unaffected packages' unit tests. **E2E smoke always runs.**

### 7.2 Nightly pipeline (main branch)
- Full Playwright matrix (all 5 projects), visual regression, and `@perf` with budgets.
- Browser-mode integration on Firefox and WebKit.
- Lighthouse CI.
- StrykerJS mutation testing.
- Fuzz tests with a higher run count (`fast-check` `numRuns: 10_000`).
- ZAP full/API scan, Trivy image + IaC scans (Phase 5).
- Android emulator mobile smoke + MobSF scan (Phase 4).
- Results are posted as a summary. Failures open or update a GitHub issue labelled `nightly-failure`.

### 7.3 Release pipeline (tag `v*`)
- Everything in nightly, plus:
  - the golden backup files restore test
  - migration-upgrade tests from every released schema version
  - SBOM (CycloneDX) attached to the release
  - the manual checklist from section 8 signed off in the release PR
- **The release is blocked if any of these are open:** an unresolved High security finding, or an unchecked manual item.

### 7.4 Build integrity checks
A Node script `scripts/verify-build.mjs` runs after the production build and fails if:
- the bundle contains e2e-only markers (e.g. the string `__E2E_HOOKS__`), `debugger` statements, or source maps for the production target
- `index.html` lacks the expected CSP, or the CSP contains `unsafe-inline` / `unsafe-eval`
- any asset references a third-party runtime origin not in the allow-list
- the service worker precache includes anything other than app-shell assets (no data/API responses)

---

## 8. Manual test checklists (per milestone)

Record results in `docs/test-reports/<milestone>.md` (date, tester, build/commit, device/browser, pass/fail, notes). The agent prepares the file; the human (or the agent, if it has device access) executes it.

### 8.1 M1/M2 — Web local MVP and portability
- [ ] Install as PWA on Windows (Edge/Chrome) and Android Chrome; launch offline
- [ ] Usable on a 360 px wide screen, 200% zoom and keyboard-only (Tab order, visible focus, Esc closes dialogs)
- [ ] Screen reader smoke test (NVDA on Windows; TalkBack on Android): onboarding, add expense, list, dashboard summary
- [ ] Dark mode contrast
- [ ] Import a real bank CSV export (after anonymizing it) and note mapping gaps
- [ ] Browser "clear site data" → app shows onboarding, not a crash; a warning about persistent storage is shown if denied
- [ ] SEC-W17 exploratory security session (60 min, timeboxed; findings logged)

### 8.2 M3 — Cloud backup
- [ ] Real OneDrive, Google Drive and Dropbox accounts (test accounts): connect, back up, restore on a second browser profile, revoke access in the provider's settings → app handles 401 gracefully
- [ ] Verify in each provider's web UI that the file is in the app folder only and its content is ciphertext

### 8.3 M4 — Mobile
- [ ] Android physical device + emulator (a native iOS app is out of scope; iPhones use the PWA, covered by the WebKit / mobile-safari projects)
- [ ] Install, onboarding, biometric unlock, background lock, share/export CSV, import from Files app, OAuth deep links
- [ ] App upgrade from the previous version keeps data (install the old APK → add data → install the new APK)
- [ ] SEC-M09 MASTG manual checks

### 8.4 M5 — Server / self-hosted / cloud
- [ ] `docker compose up` on a clean Linux VM following `docs/self-hosting.md` verbatim
- [ ] Two devices syncing, including an offline edit conflict
- [ ] Postgres backup and restore drill following the docs
- [ ] Upgrade drill: previous release → current, with data preserved
- [ ] Review of ZAP/Trivy reports; triage recorded

---

## 9. Quality gates and policies

### 9.1 Definition of Done — testing part (adds to BUILD_PLAN §5)
- [ ] The tests required for the step in [section 10](#10-tests-required-per-build-step) exist and pass.
- [ ] Coverage thresholds for touched packages are met.
- [ ] New user-facing flows have an E2E journey or extend an existing one.
- [ ] New input surfaces (form field, file import, API route, provider response) have validation, fuzz or negative tests and a matching SEC-* row (add the row if it's new).
- [ ] No new skipped tests (`it.skip`, `test.fixme`) without a linked issue and a dated comment.

### 9.2 Severity and release blocking
| Severity | Examples | Release |
|---|---|---|
| Critical | data loss, plaintext financial data at rest, auth bypass, wrong totals | Block; fix immediately |
| High | XSS, CSP bypass, crash on import/restore, IDOR | Block |
| Medium | a11y serious violation, perf budget exceeded > 20% | Block unless a waiver is documented by the human |
| Low | cosmetic, minor copy issues | Don't block |

### 9.3 Flaky test policy
- On CI, 2 retries are allowed only for E2E and browser-mode tests. Any test that passed only on retry is listed in the CI summary.
- A test that flakes twice in 7 days gets tagged `@quarantine`, excluded from blocking runs, and gets a tracking issue. It must be fixed or deleted within 7 days. **Never quarantine security tests**: fix them.
- Typical root causes to check first: missing web-first assertions, real timers, shared state between tests, animation timing (disable animations in e2e via `prefers-reduced-motion` emulation), unmocked network.

### 9.4 Test maintenance
- Delete tests for deleted features in the same commit.
- Review page objects when the UI changes. Fix locators by improving accessibility, not by adding test IDs.
- Re-baseline visual snapshots only in a dedicated commit with before/after images in the PR.

---

## 10. Tests required per build step

| BUILD_PLAN step | Required tests (IDs/sections from this file) |
|---|---|
| 0.1–0.2 | Lint rule self-tests: a fixture file per banned pattern must fail ESLint (`eslint --no-ignore` in a test) |
| 0.3 | Vitest projects + one sample test per package; Playwright config + one `@smoke` test that loads the page under CSP |
| 0.4 | CI runs the PR pipeline (7.1). `scripts/verify-build.mjs` exists (7.4) |
| 1.1 | §4.1 complete, including property-based money tests; builders in `@budget/core/testing` |
| 1.2 | §4.2 complete, including known-answer vectors and the downgrade guard |
| 1.3 | §4.3 contract suite on the Node driver; migration tests; `InMemory*Repository` fakes pass the contract |
| 1.4 | §4.7 browser-mode tests (Chromium); SEC-W03 scan helper |
| 1.5 | Component: route guards, passphrase policy (SEC-W07), auto-lock (SEC-W08). E2E: J1, J7, J8, J9; global guard fixture active (SEC-W02, W05, W12); axe on these screens |
| 1.6 | Component tests for the category form/delete flow; E2E J6 |
| 1.7 | Component form tests (§4.6); E2E J2, J3, J4; SEC-W01 on note and category name |
| 1.8 | E2E J5 (+ SEC-W04); `@perf` list budgets with 10k rows |
| 1.9 | Unit totals versus independently computed values; E2E dashboard assertions in J2/J3; chart a11y alternative |
| 1.10 | E2E J15, J16; Lighthouse CI config; build-integrity check of the SW precache |
| 2.1 | §4.4 export tests; SEC-W10 |
| 2.2 | §4.4 import + fuzz; fixtures listed below; E2E J10, J11; SEC-W11 |
| 2.3 | §4.5 backup tests; first golden file `v1`; E2E J12; SEC-W09 |
| 3.1 | `FakeBackupProvider` contract; E2E J13 with the fake |
| 3.2–3.4 | MSW adapter tests per provider (§4.5); OAuth tests SEC-W13; manual 8.2 |
| 3.5 | Unit scheduling tests with fake timers |
| 4.1–4.3 | Contract suite on `NativeSqlDriver` (emulator); WebdriverIO smoke (launch, onboarding, add, lock on background, unlock); SEC-M01…M08 |
| 4.4 | Release pipeline mobile part; manual 8.3 |
| 5.1 | §4.8 inject tests; SEC-S05, S07, S08, S09 |
| 5.2 | Contract suite on Postgres; schema parity; SEC-S01 matrix |
| 5.3 | SEC-S02, S03, S04, S06, S10; mock OIDC provider |
| 5.4 | §4.8 sync tests; E2E two-context sync journey |
| 5.5 | SEC-S12, S13, S14; docker-compose smoke in CI |
| 5.6 | ZAP baseline against staging; manual 8.4 |

**CSV fixtures to create in Step 2.2** (`/test-data/csv/`):
`valid-basic.csv`, `valid-semicolon-decimal-comma.csv`, `valid-bom-crlf.csv`, `valid-unicode.csv`, `mixed-invalid-rows.csv`, `duplicates-by-id.csv`, `duplicates-by-tuple.csv`, `missing-columns.csv`, `extra-columns.csv`, `header-only.csv`, `empty.csv`, `formula-injection.csv`, `xss-payloads.csv`, `too-many-rows.csv` (generated at test time, not committed), `too-large.csv` (generated at test time), `long-field.csv`.
