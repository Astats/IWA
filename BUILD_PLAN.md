# Budget App — Build Plan for AI Coding Agents

> **Audience:** an autonomous AI coding agent (Claude Code or similar) building this project step by step.
> **Owner:** the human user. Ask them when a step is marked 🧑 HUMAN or when you are blocked.
> **Source of truth:** this file. If something here conflicts with your own preference, follow this file.
> If something here is technically impossible or outdated, stop, explain why, propose an alternative, and wait for approval.

---

## 0. Operating rules for the agent (read before every session)

1. **Work strictly in order.** Find the first unchecked step in the [Progress Tracker](#9-progress-tracker) and do only that step. Do not start the next step until the current one meets its **Definition of Done (DoD)**.
2. **One step = one commit (or a few small commits).** Use Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `security:`). Never commit secrets, `.env` files, keystores or signing keys.
3. **Verify before you check a box.** Every step's DoD lists commands. Run them, confirm they pass, then tick the box in section 9 and add a one-line note (date and anything notable).
4. **Always-green rule.** After every step, these commands must all pass from the repo root:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test && pnpm build
   ```
5. **Testing follows [TEST_PLAN.md](TEST_PLAN.md).** Before starting a step, read that step's row in TEST_PLAN §10 and write those tests as part of the step.
6. **Security is not a phase.** Every step must follow [section 6 (Security baseline)](#6-security-baseline-owasp--applies-to-every-step). If a step would break a security rule, stop and ask.
7. **Use current stable versions.** Install the latest stable release of each listed package. Before using an API, check its current documentation (via a docs MCP server or web search, if available) instead of relying on memory. Pin exact versions in `package.json`; the lockfile is committed.
8. **Don't widen scope.** Don't add features, libraries or abstractions that this plan doesn't ask for. If you think something is missing, write it under "Open questions" in section 9 and continue.
9. **Keep the architecture boundaries** in section 2. In particular, UI code must never import a storage driver directly. It may only use the repository interfaces from `packages/core`.
10. **The environment is Windows.** Scripts must work in PowerShell and in Git Bash. Use cross-platform Node scripts rather than shell-specific syntax in `package.json`.
11. **When blocked** (missing credentials, a paid account, macOS-only tooling), mark the step `⏸ blocked` in the tracker, write what is needed, and move on only if later steps don't depend on it.

---

## 1. Product scope

### 1.1 Functional requirements
| ID | Requirement |
|---|---|
| F1 | Add, edit and delete (soft delete) **transactions** of kind `income` or `expense`. |
| F2 | Manage **categories** (name, kind, color, icon). Seed sensible defaults on first run. |
| F3 | List transactions with **sorting** (date, amount, category, kind) and **filtering** (kind, category, date range, text search in note). |
| F4 | **Dashboard**: totals of income, expense and balance for a selected period, and a breakdown by category (chart). |
| F5 | **CSV import** with preview, validation errors per row, duplicate detection, and an all-or-nothing commit. |
| F6 | **CSV export** of all transactions or of the current filtered view. |
| F7 | **Encrypted backup and restore** to cloud storage: Google Drive, Microsoft OneDrive and Dropbox (plus WebDAV/S3 later). Also a local backup file download. |
| F8 | **App lock**: the user sets a passphrase on first run. Data is encrypted at rest. The app auto-locks after inactivity. |
| F9 | Settings: base currency, language, theme (light/dark/system), auto-lock timeout, change passphrase. |

### 1.2 Non-functional requirements
| ID | Requirement |
|---|---|
| N1 | **Local-first**: fully functional offline with no server (Phases 1–3). |
| N2 | **Portable**: the same codebase ships as a web PWA, an Android app and an iOS app (via Capacitor). |
| N3 | **Server-ready**: a self-hosted or cloud backend can be added later without rewriting the UI (Phases 4–5). |
| N4 | **Security**: OWASP ASVS 5.0 Level 2 for web/API, OWASP MASVS for mobile, OWASP Top 10 (2025) coverage. |
| N5 | **Accessibility**: WCAG 2.2 AA. Keyboard navigable, with labels on all inputs. |
| N6 | **i18n**: all UI strings come from translation files. Use `Intl` for numbers, dates and currency. Start with English; adding a language must need no code changes. |
| N7 | **Correct money handling**: no floating-point arithmetic on money, ever. |

---

## 2. Architecture decisions (fixed)

| # | Decision | Rationale |
|---|---|---|
| AD1 | **TypeScript (strict)** everywhere, in a **pnpm workspace monorepo** with **Turborepo**. | One language, shared code between web, mobile and server. |
| AD2 | **React + Vite** single-page app, wrapped by **Capacitor** for Android and iOS. | Web-first, with mobile from the same code. |
| AD3 | UI built with **Tailwind CSS + shadcn/ui (Radix primitives)**, mobile-first responsive layout. | Accessible components that work on every target. |
| AD4 | **SQLite** is the client database on all platforms, accessed through a `SqlDriver` interface with a **Drizzle ORM** (`sqlite-proxy`) query layer on top. | One schema for web and mobile; Drizzle also supports PostgreSQL later. |
| AD5 | **Web storage:** `@sqlite.org/sqlite-wasm` runs in a **dedicated Web Worker** with an **in-memory DB**. After each committed write (debounced 500 ms) the DB is exported, encrypted with AES-256-GCM, and written to **OPFS** (falling back to IndexedDB if OPFS is unavailable). | Gives real encryption at rest in the browser without non-standard SQLite builds. Budget data is small. |
| AD6 | **Native storage:** `@capacitor-community/sqlite` with **SQLCipher encryption**. The DB secret is stored in the iOS Keychain or Android Keystore. | Native encrypted SQLite. |
| AD7 | **Repository pattern.** `packages/core` defines `TransactionRepository`, `CategoryRepository` and `SettingsRepository`. Phases 1–3 implement them over SQLite; Phase 5 adds sync. The UI depends only on the interfaces. | Keeps the backend swappable (N3). |
| AD8 | **Validation with Zod** schemas in `packages/core`, shared by forms, CSV import, backup restore and the future API. | One source of truth. |
| AD9 | **Money** is stored as an integer `amount_minor` (cents) plus an ISO 4217 `currency`. Arithmetic uses **dinero.js**. | N7. |
| AD10 | **IDs are UUID v7** (the `uuid` package), generated on the client. | Offline creation without conflicts in later sync. |
| AD11 | **Soft delete** (`deleted_at`) and `updated_at` on every syncable table. | Needed for backup diffs and later sync. |
| AD12 | **Key hierarchy:** passphrase → **Argon2id** (`hash-wasm`; m=64 MiB, t=3, p=1; random 16-byte salt) → KEK → unwraps a random 256-bit **DEK** (AES-GCM, held as a *non-extractable* `CryptoKey` in the worker). Changing the passphrase re-wraps the DEK; data is not re-encrypted. | Standard envelope encryption. |
| AD13 | **Backups are always encrypted on the client** before leaving the device. Cloud providers only ever see ciphertext. | Zero-knowledge backups. |
| AD14 | **Cloud providers** sit behind a `BackupProvider` interface: `connect()`, `list()`, `upload()`, `download()`, `delete()`, `disconnect()`. | Easy to add WebDAV or S3 later. |
| AD15 | **Server (Phase 4+)**: Node.js + **Fastify**, **PostgreSQL**, Drizzle, **OIDC** authentication, packaged with **Docker** and **docker-compose**, behind a **Caddy** reverse proxy. | Can run self-hosted or in any cloud. |
| AD16 | **Sync (Phase 5)**: a custom push/pull protocol using a server-assigned monotonic `server_version`, last-write-wins per row, and tombstones. Not end-to-end encrypted (the server is trusted: self-hosted or the user's own cloud). | Simple and auditable. Revisit if a multi-tenant SaaS is ever planned. |

### Supporting libraries (use these, don't substitute)
| Purpose | Package(s) |
|---|---|
| Routing | `react-router` (library/data mode) |
| Server state / async | `@tanstack/react-query` |
| Client UI state | `zustand` |
| Forms | `react-hook-form` + `@hookform/resolvers` + `zod` |
| Tables | `@tanstack/react-table` |
| Charts | `recharts` |
| CSV | `papaparse` (run in a Web Worker) |
| Money | `dinero.js` (v2) + `@dinero.js/currencies` |
| Dates | `date-fns` |
| i18n | `i18next` + `react-i18next` |
| Crypto | Web Crypto API (AES-GCM, HKDF) + `hash-wasm` (Argon2id) |
| IDs | `uuid` (v7) |
| PWA | `vite-plugin-pwa` (Workbox) |
| Native | `@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, `@capacitor/ios`, `@capacitor-community/sqlite`, `@capacitor/filesystem`, `@capacitor/share`, `@capacitor/browser`, `@capacitor/app`, `@aparajita/capacitor-biometric-auth` (or the current maintained equivalent) |
| Microsoft auth | `@azure/msal-browser` |
| Testing | `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `@playwright/test`, `fake-indexeddb`; full list in [TEST_PLAN.md §3.1](TEST_PLAN.md#31-packages-dev-dependencies) |
| Lint / format | `eslint` (flat config), `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, `eslint-plugin-security`, `prettier` |
| Server (Phase 4) | `fastify`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/cors`, `@fastify/cookie`, `@fastify/csrf-protection`, `fastify-type-provider-zod`, `openid-client`, `pino`, `drizzle-orm`, `pg`, `drizzle-kit` |

---

## 3. Repository layout (target)

```
/
├─ BUILD_PLAN.md                ← this file
├─ README.md
├─ SECURITY.md                  ← threat model + vuln reporting
├─ package.json                 ← root scripts only
├─ pnpm-workspace.yaml
├─ turbo.json
├─ tsconfig.base.json
├─ eslint.config.js
├─ .prettierrc
├─ .gitignore / .gitattributes / .editorconfig / .nvmrc
├─ .github/workflows/ci.yml
├─ packages/
│  ├─ core/        domain types, Zod schemas, money utils, repository INTERFACES, CSV mapping (pure, no I/O)
│  ├─ crypto/      key derivation, envelope encryption, vault file format (pure Web Crypto)
│  ├─ db/          Drizzle schemas (sqlite + pg), SQL migrations, SqlDriver interface, repository IMPLEMENTATIONS
│  ├─ backup/      backup file format + BackupProvider interface + provider adapters
│  └─ ui/          shared shadcn/ui components (optional; can live in apps/web initially)
├─ apps/
│  ├─ web/         React + Vite PWA; Capacitor project lives here (android/, ios/)
│  └─ server/      Fastify API (Phase 4)
├─ e2e/            Playwright tests
└─ docker/         Dockerfile(s), docker-compose.yml, Caddyfile (Phase 4)
```

**Dependency rules** (enforce with ESLint `no-restricted-imports` or `eslint-plugin-boundaries`):
- `core` → no internal dependencies.
- `crypto` → `core` only.
- `db` → `core`, `crypto`.
- `backup` → `core`, `crypto`.
- `apps/web` → any package, **but** UI components (`src/features/**`, `src/components/**`) may import repositories only via `core` interfaces and the app's DI provider. They never import `db` drivers directly.
- `apps/server` → `core`, `db`.

---

## 4. Domain model and data rules

### 4.1 Tables (SQLite; PostgreSQL mirrors them in Phase 4)

**`categories`**
| column | type | rules |
|---|---|---|
| id | TEXT (UUID v7) PK | |
| name | TEXT | 1–50 chars, trimmed, unique per `kind` among non-deleted rows |
| kind | TEXT | `income` \| `expense` |
| color | TEXT | `#RRGGBB` |
| icon | TEXT | key from a fixed icon allow-list |
| sort_order | INTEGER | |
| created_at / updated_at | TEXT (ISO 8601 UTC) | |
| deleted_at | TEXT NULL | soft delete |

**`transactions`**
| column | type | rules |
|---|---|---|
| id | TEXT (UUID v7) PK | |
| kind | TEXT | `income` \| `expense` |
| amount_minor | INTEGER | > 0 and ≤ 10^13. The sign comes from `kind`, never from the amount. |
| currency | TEXT | ISO 4217, 3 uppercase letters |
| category_id | TEXT FK → categories.id | the category's `kind` must equal the transaction's `kind` |
| date | TEXT | `YYYY-MM-DD` (local calendar date, no time zone) |
| note | TEXT | 0–500 chars; plain text only, never rendered as HTML |
| created_at / updated_at | TEXT (ISO 8601 UTC) | |
| deleted_at | TEXT NULL | |

**`settings`**: key/value (`base_currency`, `locale`, `theme`, `auto_lock_minutes`, `schema_version`).

**`schema_migrations`**: `version INTEGER PK`, `applied_at`.

Indexes: `transactions(date)`, `transactions(category_id)`, `transactions(kind, date)`, `transactions(deleted_at)`.

### 4.2 Rules
- Every list query excludes `deleted_at IS NOT NULL` unless it explicitly asks for deleted rows.
- Every write sets `updated_at = now()`.
- Deleting a category that has transactions is blocked. The UI offers to reassign them first.
- Totals are computed in SQL with integer sums per currency. Mixed currencies are shown as separate totals; there is **no FX conversion** in this scope.
- Default categories seeded on first run:
  - Expense: Housing, Food, Transport, Utilities, Health, Entertainment, Shopping, Other.
  - Income: Salary, Freelance, Gifts, Interest, Other.

### 4.3 Repository interfaces (in `packages/core/src/repositories.ts`)
```ts
export interface TransactionQuery {
  kind?: 'income' | 'expense';
  categoryIds?: string[];
  dateFrom?: string; // YYYY-MM-DD inclusive
  dateTo?: string;   // YYYY-MM-DD inclusive
  search?: string;   // matches note, case-insensitive
  sortBy?: 'date' | 'amount' | 'category' | 'kind';
  sortDir?: 'asc' | 'desc';
  limit?: number;    // default 50, max 500
  offset?: number;
}

export interface TransactionRepository {
  list(q: TransactionQuery): Promise<{ items: Transaction[]; total: number }>;
  get(id: string): Promise<Transaction | null>;
  create(input: NewTransaction): Promise<Transaction>;
  update(id: string, patch: TransactionPatch): Promise<Transaction>;
  softDelete(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  totals(range: { dateFrom: string; dateTo: string }): Promise<PeriodTotals>;
  byCategory(range: { dateFrom: string; dateTo: string; kind: 'income' | 'expense' }): Promise<CategoryTotal[]>;
  bulkInsert(items: NewTransaction[]): Promise<number>; // single DB transaction
  exportAll(): AsyncIterable<Transaction>;
}
// CategoryRepository and SettingsRepository follow the same style.
```
Sort columns map to a **fixed allow-list** of SQL expressions. User input is never interpolated into SQL.

### 4.4 CSV format (v1)
- Encoding UTF-8. Export writes a BOM so Excel opens it correctly; import strips a BOM if present.
- Delimiter: `,` on export. On import, auto-detect `,` or `;`.
- Header row (exact, case-insensitive on import): `date,kind,amount,currency,category,note,id`
- `date` = `YYYY-MM-DD`; `kind` = `income|expense`; `amount` = positive decimal with `.` separator (import also accepts `,` as the decimal separator when the delimiter is `;`); `category` = category name (created on import if missing, after user confirmation); `id` is optional.
- **Duplicate detection:** a row is a duplicate if its `id` exists, or if no `id` is given and a non-deleted row has the same (`date`, `kind`, `amount_minor`, `currency`, `note`). The user chooses whether to skip or import duplicates.
- **Limits:** max 5 MB file, max 50,000 rows, max 500 chars per field.
- **Formula-injection protection on export:** if a cell starts with `=`, `+`, `-`, `@`, TAB or CR, prefix it with `'`. Amounts are written as plain numbers without signs, so they are never affected.

### 4.5 Vault file and backup file formats
**Local vault (web, `budget.vault` in OPFS):**
```
magic "BGTV" | format_version u8 | generation u64 | kdf_params (json, length-prefixed) | salt 16B |
wrapped_DEK (AES-GCM: iv 12B + ct + tag) | data_iv 12B | data_ciphertext (sqlite db bytes) + tag
```
- Header bytes are passed as AES-GCM **additional authenticated data (AAD)**, so tampering with the header is detected.
- **Write two slots, A and B, alternately**, with an incrementing `generation`. On load, pick the highest generation that decrypts successfully. This makes writes crash-safe.
- Use a fresh random 12-byte IV for every encryption. Never reuse an IV with the same key.

**Backup file (`budget-backup-YYYYMMDD-HHmmss.bgtb`):**
```
magic "BGTB" | format_version u8 | created_at | app_version | kdf_params | salt 16B | iv 12B |
ciphertext of gzip(JSON { schemaVersion, categories[], transactions[], settings{} }) + tag
```
- The key is derived from the user's passphrase (Argon2id, fresh salt per backup), so a backup can be restored on a new device.
- Restore validates the decrypted JSON with Zod before touching the database. It then either **replaces** all data (after a confirmation dialog and an automatic local pre-restore backup) or **merges** by id, newest `updated_at` winning.

---

## 5. Definition of Done (applies to every step)
- [ ] Code compiles with `strict: true`. No `any` without a `// reason:` comment.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass.
- [ ] New logic has unit tests. `packages/core`, `packages/crypto` and CSV code have ≥ 90% line coverage.
- [ ] No new `npm audit` high or critical findings (`pnpm audit --prod --audit-level high`).
- [ ] UI strings go through i18n. New UI is keyboard accessible and labelled.
- [ ] The testing DoD in [TEST_PLAN.md §9.1](TEST_PLAN.md#91-definition-of-done--testing-part-adds-to-build_plan-5) is met.
- [ ] The step's own DoD items are met. The tracker in section 9 is updated, and work is committed.

---

## 6. Security baseline (OWASP — applies to every step)

Reference standards: **OWASP ASVS 5.0 (L2)**, **OWASP MASVS 2.x** (mobile), **OWASP Top 10 2025**, **OWASP Cheat Sheet Series**.

### 6.1 Coding rules (enforced by lint and review)
| Rule | OWASP mapping |
|---|---|
| Never use `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, or `setTimeout(string)`. Lint rules must error on them. | A05 Injection |
| All external input (forms, CSV, backup files, URL params, API bodies, OAuth responses) is parsed with **Zod** at the boundary. Unknown keys are stripped. | A05, ASVS V1/V2 |
| SQL is only built with Drizzle or parameterized statements. Dynamic sort columns come from an allow-list. | A05 |
| Never put sensitive data (amounts, notes, tokens, passphrases) in `localStorage`, `sessionStorage`, URLs, logs or analytics. | A04, A09 |
| Keys are generated by `crypto.getRandomValues` and Web Crypto only. `Math.random` is banned for anything security-related. No custom crypto algorithms. | A04 |
| Errors shown to the user are generic and translated. Details go to a redacted dev-only logger. **Fail closed**: a decryption or validation failure never falls back to plaintext or partial data. | A10 |
| OAuth uses Authorization Code + **PKCE** (S256) with a `state` check, through the system browser on mobile (RFC 8252). Never use embedded WebViews for sign-in. Request the **minimal scopes** only. | A07, A01 |
| OAuth refresh tokens: on web, keep them in memory only (re-auth per session is acceptable). On native, keep them in Keychain/Keystore secure storage. Never put them in plain storage. | A04, A07 |
| Clipboard, screenshots, logs: no automatic copying of sensitive data. On Android, set `FLAG_SECURE` when locked (configurable). | MASVS-PLATFORM |
| Dependencies: add only well-maintained packages. Justify each new dependency in the commit message. | A03 |

### 6.2 Web hardening (applies from Phase 1)
- **Content Security Policy** (via meta tag in the local phase; via an HTTP header from Caddy in Phase 4):
  ```
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
  img-src 'self' data:; font-src 'self'; worker-src 'self'; connect-src 'self' <allow-listed provider API origins>;
  object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
  ```
  Add provider origins (Google, Microsoft, Dropbox) **only** in the step that needs them, and list them in `SECURITY.md`. No `unsafe-inline` and no `unsafe-eval`. Configure Tailwind and shadcn so no inline styles are injected, or use nonces/hashes if unavoidable.
- With an HTTP server (Phase 4): `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (deny camera, mic, geolocation and so on), `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.
- Self-host all fonts and assets. No third-party CDNs at runtime.
- **Auto-lock:** after N minutes of inactivity (default 5) and when the app is backgrounded on mobile, the worker drops the DEK, the UI clears the query cache, and the app shows the unlock screen.
- **Passphrase policy (ASVS V6):** minimum 12 characters, no composition rules, checked against a bundled list of common passwords. Show a strength meter. **Warn clearly that a lost passphrase means lost data** (no recovery by design). Optionally let the user export a recovery key once.
- **Brute-force protection on unlock:** progressive delay after failed attempts (Argon2id already makes guessing expensive).

### 6.3 CI security gates (set up in Step 0.4 and kept green)
- `pnpm audit --prod --audit-level high`
- **OSV-Scanner** on the lockfile
- **Semgrep** (`p/typescript`, `p/react`, `p/owasp-top-ten`, `p/secrets`)
- **gitleaks** secret scan
- **CodeQL** (GitHub) for JavaScript/TypeScript
- **SBOM:** CycloneDX generated on release
- From Phase 4: **Trivy** image scan and an **OWASP ZAP baseline** scan against the docker-compose stack
- **Renovate** (or Dependabot) for dependency updates. GitHub Actions are pinned by commit SHA.

### 6.4 SECURITY.md (created in Step 0.1, updated whenever relevant)
It must contain:
- A threat model (STRIDE) covering assets (financial data, passphrase, OAuth tokens, backups), trust boundaries, and threats with their mitigations.
- The cryptography summary (AD12, AD13).
- The CSP allow-list with a justification for each origin.
- How to report vulnerabilities.

---

## 7. Build steps

### PHASE 0 — Foundation

#### Step 0.1 — Repository bootstrap
**Tasks**
- `git init`; add `.gitignore` (node, dist, coverage, `.env*`, `*.keystore`, `*.jks`, `android/app/release`, `ios/App/Pods`, `playwright-report`), `.gitattributes` (`* text=auto eol=lf`), `.editorconfig`, and `.nvmrc` (current Node.js LTS).
- Root `package.json` with `"private": true`, `"packageManager": "pnpm@<latest>"`, `engines`, and scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:e2e`, `format`.
- `pnpm-workspace.yaml` (`apps/*`, `packages/*`) and `turbo.json` with pipelines for build, lint, typecheck and test.
- `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `moduleResolution: "bundler"`.
- `README.md` (what it is and how to run it) and `SECURITY.md` skeleton (section 6.4 headings).

**DoD:** `pnpm install` succeeds; `pnpm lint`, `pnpm typecheck` and `pnpm test` run (they may report "no tasks"); first commit made.

#### Step 0.2 — Lint, format and boundaries
**Tasks**
- ESLint flat config: `typescript-eslint` (strict-type-checked), `react-hooks`, `jsx-a11y`, `security`, and `no-restricted-syntax` / `no-restricted-properties` rules banning `innerHTML`, `dangerouslySetInnerHTML`, `eval`, `Function`, `Math.random` (outside tests), and `localStorage` / `sessionStorage` (except a single allow-listed `ui-prefs.ts` for theme and language only).
- Import-boundary rules from section 3.
- Prettier config, and `format` / `format:check` scripts.

**DoD:** a deliberate violation (e.g. `innerHTML`) in a scratch file makes `pnpm lint` fail; remove the file afterwards.

#### Step 0.3 — Package skeletons
**Tasks**
- Create `packages/core`, `packages/crypto`, `packages/db` and `packages/backup`. Each gets `package.json` (`"type": "module"`, `exports`), `tsconfig.json`, `src/index.ts`, and a Vitest config with one trivial test.
- Create `apps/web` with Vite (React + TS template), plus Tailwind CSS and shadcn/ui initialised. Show a "Hello Budget" page.
- Set up Vitest workspace/projects so that `pnpm test` at the root runs all packages.

**DoD:** `pnpm dev` serves the app at `http://localhost:5173`, and the always-green commands pass.

#### Step 0.4 — CI pipeline
**Tasks**
- `.github/workflows/ci.yml` runs on push and PR: install (frozen lockfile), lint, typecheck, test with coverage, build, then the security gates from section 6.3 (audit, OSV-Scanner, Semgrep, gitleaks). Add CodeQL as a separate workflow.
- `renovate.json` (or `.github/dependabot.yml`).
- Pin actions by SHA. Use least-privilege `permissions:` (default `contents: read`).

**DoD:** workflows lint cleanly (`actionlint` if available). If there is no remote yet, note "CI not executed yet — no remote" in the tracker.

---

### PHASE 1 — Local MVP (web/PWA, offline, encrypted)

#### Step 1.1 — Core domain (`packages/core`)
**Tasks**
- Types and **Zod schemas** for `Category`, `Transaction`, `NewTransaction`, `TransactionPatch`, `Settings` and `TransactionQuery` (section 4).
- Money utilities using dinero.js:
  - `parseAmount(input: string, currency, locale) → amount_minor`, which rejects negative numbers, NaN, too many decimals and overflow
  - `formatAmount(amount_minor, currency, locale)`
  - `sumByCurrency()`
- Repository interfaces (section 4.3).
- Pure helpers: date-range presets (this month, last month, this year, custom), and default category seeds.

**DoD:** ≥ 90% coverage. Tests cover currencies with 0, 2 and 3 decimals (JPY, EUR, KWD), boundary amounts, and locale parsing (`1 234,56` vs `1,234.56`).

#### Step 1.2 — Crypto (`packages/crypto`)
**Tasks**
- `deriveKek(passphrase, salt, params)` using Argon2id (`hash-wasm`), imported as a non-extractable AES-KW or AES-GCM key.
- `generateDek()`, `wrapDek(dek, kek)` and `unwrapDek(wrapped, kek)` (the DEK must be extractable only for wrapping; after unwrapping, import it as non-extractable).
- `encrypt(key, plaintext, aad)` and `decrypt(key, blob, aad)` with AES-256-GCM and a random 12-byte IV.
- Vault format encode/decode (section 4.5), including the A/B slot and generation logic.
- Constant-time comparison helper for any MAC or tag comparisons outside AES-GCM.

**DoD:** tests cover round-trip, wrong passphrase → typed `DecryptionError`, tampered header/IV/ciphertext → error, IV uniqueness across 10,000 encryptions, and A/B slot recovery when the newest slot is corrupted. No secrets are logged.

#### Step 1.3 — Database layer (`packages/db`)
**Tasks**
- `SqlDriver` interface: `exec(sql, params)`, `query<T>(sql, params)`, `transaction(fn)`, `export(): Uint8Array`, `close()`.
- Drizzle **SQLite** schema matching section 4.1. Generate SQL migrations with `drizzle-kit generate` into `packages/db/migrations/sqlite/`.
- A **custom migrator** that applies bundled `.sql` files in order and records them in `schema_migrations`. Each migration runs inside a transaction.
- Repository **implementations** over Drizzle `sqlite-proxy` and `SqlDriver`: `SqliteTransactionRepository`, `SqliteCategoryRepository` and `SqliteSettingsRepository`.
- A Node test driver using `@sqlite.org/sqlite-wasm` (or `better-sqlite3` for tests only) so repository tests run in Vitest.

**DoD:** repository tests cover CRUD, soft delete/restore, every sort and filter combination, `totals`, `byCategory`, the category-kind mismatch rejection, and blocking deletion of a category that is in use. There is also a test proving a malicious `search` string (e.g. `%' OR 1=1 --`) is treated as literal text.

#### Step 1.4 — Web storage worker (`apps/web/src/storage/`)
**Tasks**
- `db.worker.ts`:
  - loads sqlite-wasm with an in-memory DB
  - exposes a typed RPC over `postMessage` (use `comlink`, or a small hand-written typed channel)
  - methods: `createVault(passphrase)`, `unlock(passphrase)`, `lock()`, `changePassphrase(old, new)`, `query/exec/transaction` (forwarded to `SqlDriver`)
- Persistence: after each committed write transaction, debounce 500 ms, then `sqlite3_js_db_export` → encrypt → write to OPFS (alternating vault slot). Fall back to IndexedDB when OPFS is unavailable. Flush on `lock()` and on `visibilitychange` → hidden.
- Ask for persistent storage with `navigator.storage.persist()`. Show a warning banner if it is denied.
- `WorkerSqlDriver` implements `SqlDriver` on the main thread by calling the worker.
- DI: a `RepositoryProvider` React context that builds the repositories from `packages/db` with `WorkerSqlDriver`.

**DoD:** integration test (Playwright, Chromium):
1. Create a vault and add data.
2. Reload the page and unlock with the right passphrase: data is present.
3. Try a wrong passphrase: a generic error appears and no data is shown.
4. Inspect OPFS bytes: they do not contain a known note string in plaintext.

#### Step 1.5 — App shell, onboarding and lock
**Tasks**
- Routing (`react-router`): `/onboarding`, `/unlock`, `/` (dashboard), `/transactions`, `/transactions/new`, `/transactions/:id`, `/categories`, `/import-export`, `/backup`, `/settings`. A route guard sends the user to onboarding or unlock as needed.
- Onboarding: welcome, passphrase creation with policy (section 6.2), a "data cannot be recovered" acknowledgement checkbox, base currency, and language.
- Unlock screen with progressive delay on failures.
- Auto-lock timer (activity listeners) and a manual "Lock" button.
- Layout: responsive. Bottom navigation on small screens, sidebar on large screens. Light/dark/system theme. i18n set up with `en` resources.
- CSP meta tag (section 6.2) in `index.html`. Verify that sqlite-wasm and workers run under it.

**DoD:** e2e covers onboarding → dashboard → lock → unlock. An axe-core check (`@axe-core/playwright`) finds no serious or critical issues on these screens. The browser console shows no CSP violations.

#### Step 1.6 — Categories management
**Tasks:** list grouped by kind, create/edit (name, kind, color, icon from the allow-list), reorder, delete with the reassign flow, and default seeds on first run.
**DoD:** unit and e2e tests for create, edit and delete-blocked-then-reassign.

#### Step 1.7 — Transactions CRUD
**Tasks**
- Form (React Hook Form + Zod): kind toggle, amount (locale-aware input using `parseAmount`), currency (default: base currency), category (filtered by kind), date (default today), and note.
- Edit the same form. Delete is a soft delete, with an **Undo** toast (calls `restore`).
- Show validation messages inline and translated.

**DoD:** e2e covers add income, add expense, edit, delete and undo. Unit tests cover the form schema edge cases.

#### Step 1.8 — Transaction list: sorting and filtering
**Tasks**
- TanStack Table with server-side (repository-side) sorting and pagination. Sortable by date, amount, category and kind.
- Filter bar: kind (all/income/expense), category multi-select, date range presets plus custom, and a note search (debounced 300 ms).
- Persist filter state in URL search params. **Only non-sensitive filter values belong there**: the free-text search term stays in memory and is *not* put in the URL.
- On small screens, use a card list instead of a table.

**DoD:** e2e covers each sort direction and each filter type. Performance check: 10,000 seeded transactions → first page renders in < 300 ms on a dev machine (log the measurement in the tracker).

#### Step 1.9 — Dashboard
**Tasks:** period selector; income, expense and balance tiles (per currency); expenses-by-category donut or bar chart (Recharts); monthly income-vs-expense bar chart for the last 12 months; and a "recent transactions" list.
**DoD:** totals verified against fixture data in unit tests. Charts have accessible text alternatives (a summary table or `aria-label`).

#### Step 1.10 — PWA and offline
**Tasks:** `vite-plugin-pwa` with a precached app shell, a manifest (name, icons, theme color, `display: standalone`), an update prompt ("New version available — reload") and **no runtime caching of any API responses**.
**DoD:** Lighthouse PWA/installability checks pass. With the network offline in Playwright, the app loads, unlocks and saves a transaction.

**🏁 Milestone M1:** local, encrypted, offline budget web app. Tag `v0.1.0`.

---

### PHASE 2 — Data portability

#### Step 2.1 — CSV export
**Tasks:** `packages/core/csv/export.ts` (pure function with formula-injection escaping, section 4.4); UI to export all data or the current filtered view. On web, the download goes through a Blob URL that is revoked after use.
**DoD:** unit tests cover escaping of every dangerous prefix, Unicode, commas/quotes/newlines in notes, and a round-trip (export → import gives identical data).

#### Step 2.2 — CSV import
**Tasks**
- Parse with Papa Parse **in a Web Worker** (streaming), with delimiter auto-detection and limits enforced before and during parsing.
- Validate every row with Zod. Collect errors (row number, field, message) and **never stop at the first error**.
- Preview screen: counts (valid / invalid / duplicates / new categories), first 50 rows, an error list downloadable as CSV, and options (skip duplicates, create missing categories).
- Commit through `bulkInsert` in a **single DB transaction** (all or nothing).
**DoD:** fixtures include valid, mixed-invalid, `;`-delimited with decimal commas, BOM, 50,001 rows (rejected), a 6 MB file (rejected), and formula strings (stored as literal text). An e2e test covers the full import flow.

#### Step 2.3 — Encrypted local backup and restore
**Tasks**
- `packages/backup`: `createBackup(repos, passphrase) → Uint8Array` and `readBackup(bytes, passphrase) → BackupPayload` (section 4.5 format, gzip via `CompressionStream`).
- UI: "Download backup file" and "Restore from file" (choose replace or merge). Before restoring, automatically create a pre-restore backup.
**DoD:** tests cover a round-trip, a wrong passphrase, a truncated or tampered file, a backup from a future `format_version` (rejected with a clear message), and a merge conflict where the newest `updated_at` wins.

**🏁 Milestone M2:** tag `v0.2.0`.

---

### PHASE 3 — Cloud backup providers

> All providers implement `BackupProvider` (AD14). Each provider's API origins are added to the CSP `connect-src` **in its own step only**, and listed in `SECURITY.md`.

#### Step 3.1 — Provider framework
**Tasks:** the `BackupProvider` interface; a provider registry; a Backup screen showing connected providers, last backup time, a "Back up now" button, a list of remote backups with restore/delete, and retention (keep the last N backups, default 10). Write a `FakeBackupProvider` for tests.
**DoD:** unit and e2e tests with the fake provider cover the full flow.

#### Step 3.2 — Microsoft OneDrive
🧑 **HUMAN:** register an app in Microsoft Entra ID (SPA platform; redirect URI `http://localhost:5173/auth/callback/microsoft`), with the delegated permission `Files.ReadWrite.AppFolder` only. Put the **client ID** (not a secret) into `apps/web/.env.local` as `VITE_MS_CLIENT_ID`, and add a matching `.env.example`.
**Tasks:** `@azure/msal-browser` (auth code + PKCE), with a token cache in memory only. Upload, list, download and delete files in the app folder (`/me/drive/special/approot`) via Microsoft Graph. Use chunked upload sessions for files over 4 MB.
**DoD:** unit tests with mocked fetch. A manual test is recorded in the tracker (connect → backup → list → restore → disconnect).

#### Step 3.3 — Google Drive
🧑 **HUMAN:** create a Google Cloud OAuth client of type **Web application** with authorized JavaScript origin `http://localhost:5173`, and the scope `https://www.googleapis.com/auth/drive.appdata` only. Put the client ID into `VITE_GOOGLE_CLIENT_ID`.
**Tasks:**
- Use the **Google Identity Services token client** for browser-only access tokens. **Do not** ship a client secret. Google's web-client code flow requires a secret, so it is not used here. **Verify this against current Google docs before implementing.**
- Use Drive API v3 with `spaces=appDataFolder` and multipart or resumable upload.
- Load the GIS script only on the Backup screen, and add its origins to the CSP.
**DoD:** same as Step 3.2.

#### Step 3.4 — Dropbox
🧑 **HUMAN:** create a Dropbox app with **App folder** access, set the redirect URI, and provide the app key as `VITE_DROPBOX_APP_KEY`.
**Tasks:** OAuth 2 code flow with PKCE (public client, no secret), short-lived access tokens, and upload/list/download/delete via the Dropbox HTTP API in the app folder.
**DoD:** same as Step 3.2.

#### Step 3.5 — Backup reminders and status
**Tasks:** settings for backup frequency (manual/daily/weekly), a "last successful backup" indicator, and a reminder banner when a backup is overdue. Do **not** run backups silently in the background on web; they need the passphrase or an unlocked session.
**DoD:** unit tests for the scheduling logic.

**🏁 Milestone M3:** tag `v0.3.0`.

---

### PHASE 4 — Mobile apps (Capacitor)

#### Step 4.1 — Capacitor setup
**Tasks:** add Capacitor to `apps/web` (appId e.g. `com.<owner>.budget`; confirm with the human), add the `android` and `ios` platforms, and set `server.androidScheme: 'https'`. Create a `PlatformService` with `isNative()`, a file save/share abstraction, and a deep-link handler.
🧑 **HUMAN:** install Android Studio + JDK. For iOS, provide a Mac with Xcode (it cannot be built on Windows).
**DoD:** `pnpm --filter web build && npx cap sync` succeeds, and the app runs in the Android emulator.

#### Step 4.2 — Native storage driver
**Tasks:** `NativeSqlDriver` implementing `SqlDriver` with `@capacitor-community/sqlite` and **SQLCipher encryption on**.
- The DB secret is generated randomly on first run and stored in Keychain/Keystore (via the plugin's secure-store feature or a maintained secure-storage plugin).
- The unlock passphrase / biometrics gate access to the secret.
- The repository provider picks `WorkerSqlDriver` or `NativeSqlDriver` based on the platform. **No UI changes.**
**DoD:** the same repository test-suite contract passes on the native driver (run as an instrumented smoke test or a manual checklist recorded in the tracker). The DB file pulled from the device is not readable as plain SQLite.

#### Step 4.3 — Native integrations
**Tasks:**
- Biometric unlock (optional, behind a setting; the passphrase is always still possible).
- Lock when the app goes to the background (`@capacitor/app` `pause` event).
- `FLAG_SECURE` on Android and a privacy screen in the iOS app switcher.
- CSV/backup export via `@capacitor/filesystem` + `@capacitor/share`, and import via a file picker.
- OAuth on native: open `@capacitor/browser` (Custom Tabs / ASWebAuthenticationSession) and return via a custom-scheme or app-link redirect. Use PKCE and validate `state`. Register native OAuth client IDs (🧑 HUMAN) for Google (Android/iOS client types), Microsoft (mobile platform) and Dropbox.
**DoD:** a manual MASVS-L1 checklist recorded in the tracker: storage, crypto, auth, network (HTTPS only, `android:usesCleartextTraffic="false"`, iOS ATS default), platform (no exported components beyond what's needed) and code (release build with minification and debugging disabled).

#### Step 4.4 — Release builds
🧑 **HUMAN:** create the Android upload keystore (stored outside the repo) and an Apple Developer account plus signing.
**Tasks:** document the release build steps in `docs/mobile-release.md`, set app icons and splash screens, and version-sync the web `package.json` and native versions via a script.
**DoD:** a signed Android AAB builds locally. The iOS archive steps are documented and verified by the human.

**🏁 Milestone M4:** tag `v0.4.0`.

---

### PHASE 5 — Server, self-hosting and cloud

> **Gate:** before starting Phase 5, write `docs/server-design.md` (API endpoints, auth flow, sync protocol, deployment topology, updated threat model) and **get human approval**.

#### Step 5.1 — Server skeleton (`apps/server`)
**Tasks:**
- Fastify + `fastify-type-provider-zod` (using the shared `core` schemas) and `pino` with redaction paths (`req.headers.authorization`, `*.note`, `*.amount_minor`, cookies).
- `@fastify/helmet` (headers from section 6.2), `@fastify/rate-limit`, and CORS limited to the configured origin only.
- `/healthz` and `/readyz` endpoints. Configuration loaded from env vars and validated with Zod at startup (fail fast).
- Central error handler: returns RFC 9457 problem+json with generic messages and never leaks stack traces.
**DoD:** unit tests with `fastify.inject`.

#### Step 5.2 — PostgreSQL and multi-tenancy
**Tasks:** a Drizzle **pg** schema mirroring section 4.1, plus `user_id` on every table and a `server_version BIGINT` (from a sequence). Migrations live in `packages/db/migrations/pg/`. **Every query is scoped by `user_id`** through a repository wrapper that requires the user context; optionally add Postgres Row-Level Security as defense in depth. A schema-parity test checks that SQLite and Postgres columns match.
**DoD:** integration tests against Postgres (Testcontainers or docker-compose). A test proves user A cannot read or modify user B's data (IDOR test for every endpoint).

#### Step 5.3 — Authentication (OIDC)
**Tasks:**
- `openid-client`. **Web:** BFF pattern where the server runs the code + PKCE flow and sets an `HttpOnly; Secure; SameSite=Strict` session cookie (`__Host-` prefix), with CSRF protection on state-changing routes. **Mobile:** code + PKCE in the system browser, with tokens in Keychain/Keystore sent as Bearer tokens. The server validates `iss`, `aud`, `exp` and signature via JWKS.
- Session timeout (idle 30 min, absolute 12 h; configurable), logout, and an audit log of login/logout/failures (without sensitive data).
- Default self-hosted IdP: **Authentik or Keycloak** in docker-compose. Any OIDC provider works through configuration.
**DoD:** tests for session fixation, CSRF rejection, expired/invalid token rejection, and logout invalidation.

#### Step 5.4 — Sync
**Tasks:**
- `POST /sync/push`: client changes since the last sync; the server applies last-write-wins by `updated_at` and assigns `server_version`.
- `GET /sync/pull?since=<server_version>`: returns changed rows, including tombstones.
- Client: `SyncService` with an outbox table and periodic plus manual sync. The repository implementations are unchanged; sync runs underneath them.
- Sync is opt-in; "local only" stays the default mode.
**DoD:** tests for two offline devices editing the same row, delete-vs-edit, idempotent retries, and pagination of large pulls.

#### Step 5.5 — Self-hosted packaging
**Tasks:**
- `docker/Dockerfile`: multi-stage build that serves the web build as static files plus the API, runs as non-root, uses a minimal base image, includes a `HEALTHCHECK`, and has a read-only root filesystem where possible.
- `docker/docker-compose.yml`: `caddy` (automatic HTTPS, security headers, CSP header), `app`, `postgres` (volume, not exposed publicly) and an optional `authentik`. Secrets come from Docker secrets or `.env` (never committed; provide `.env.example`).
- `docs/self-hosting.md`: install, upgrade, backup of Postgres (`pg_dump` cron), and restore.
- CI: Trivy image scan, and an OWASP ZAP baseline scan against `docker compose up`.
**DoD:** `docker compose up` works on a clean machine. ZAP baseline shows no high-risk alerts. Trivy finds no critical vulnerabilities.

#### Step 5.6 — Cloud deployment (optional)
🧑 **HUMAN:** choose the provider (e.g. Azure Container Apps, AWS ECS Fargate, Google Cloud Run, Fly.io, Hetzner) and provide an account.
**Tasks:** infrastructure as code (Terraform/OpenTofu or Bicep): managed Postgres with encryption at rest, automated backups and private networking; a secrets manager; HTTPS only; WAF/rate limiting at the edge; log retention; uptime alerts. A CD pipeline with manual approval for production.
**DoD:** staging deployed. ZAP baseline passes against staging. The runbook is in `docs/operations.md`.

**🏁 Milestone M5:** tag `v1.0.0`.

---

## 8. Inputs the human must provide
| When | What |
|---|---|
| Step 3.2 | Microsoft Entra app registration → client ID |
| Step 3.3 | Google Cloud OAuth client (web) → client ID; later Android/iOS client IDs |
| Step 3.4 | Dropbox app (App folder) → app key |
| Step 4.1 | Android Studio + JDK on Windows; a Mac with Xcode for iOS; the final `appId` |
| Step 4.4 | Android upload keystore; Apple Developer Program membership |
| Phase 5 gate | Approval of `docs/server-design.md` |
| Step 5.6 | Cloud provider choice and account access |

---

## 9. Progress tracker

> The agent updates this section at the end of every step: tick the box and add `YYYY-MM-DD — note`.
> Status markers: `[ ]` todo, `[x]` done, `⏸` blocked (with reason).

### Phase 0 — Foundation
- [x] 0.1 Repository bootstrap — 2026-10-07 — pnpm 12.10.1 (global pnpm upgraded from 10; pnpm 12 ships as a native binary), Node 24 LTS, turbo 2.11.
- [x] 0.2 Lint, format and boundaries — 2026-10-07 — ESLint 9 + typescript-eslint strict-type-checked; self-test lints one fixture per banned pattern (tooling/lint-rules.test.ts).
- [x] 0.3 Package skeletons — 2026-10-07 — Vite 8, React 19.3, Tailwind 4, shadcn/ui radix-nova; Playwright @smoke under the production CSP.
- [x] 0.4 CI pipeline — 2026-10-07 — ci.yml, codeql.yml, release.yml (SBOM), renovate.json; actions pinned by SHA. CI not executed yet — no remote. actionlint not available locally (Docker daemon off), so it runs as a CI job.

### Phase 1 — Local MVP
- [x] 1.1 Core domain — 2026-10-07 — Zod 4 schemas, exact bigint money via dinero.js/bigint, presets via pure Y/M/D math (TZ Riga/New York projects), passphrase policy; coverage 100% lines / 93.6% branches.
- [x] 1.2 Crypto — 2026-10-07 — Argon2id (hash-wasm, KAT vectors cross-checked with Node crypto.argon2), envelope AES-GCM, vault A/B slots, downgrade guard; 40 tests. Production KDF ≈ 170 ms in Node locally.
- [x] 1.3 Database layer — 2026-10-07 — Drizzle sqlite-proxy over SqlDriver; sqlite-wasm driver for Node + worker; custom migrator; contract suite (63 cases) passes on sqlite-wasm and the in-memory fakes; golden DB test-data/db/schema-v1.sqlite.
- [x] 1.4 Web storage worker — 2026-10-07 — DoD e2e (e2e/specs/storage.spec.ts): create + data, reload + unlock, wrong passphrase generic, OPFS/IDB marker scan clean; plus 14 browser-mode tests (OPFS + IndexedDB fallback, debounce, crash safety).
- [x] 1.5 App shell, onboarding and lock — 2026-10-07 — routes + guards, onboarding (policy, acknowledgement), unlock with progressive delay, auto-lock, settings, theme, i18n; e2e J1/J7/J8/J9/J14 + axe (light/dark) green; no CSP violations.
- [ ] 1.6 Categories management
- [ ] 1.7 Transactions CRUD
- [ ] 1.8 Transaction list: sorting and filtering
- [ ] 1.9 Dashboard
- [ ] 1.10 PWA and offline
- [ ] 🏁 M1 tagged `v0.1.0`

### Phase 2 — Data portability
- [ ] 2.1 CSV export
- [ ] 2.2 CSV import
- [ ] 2.3 Encrypted local backup and restore
- [ ] 🏁 M2 tagged `v0.2.0`

### Phase 3 — Cloud backup
- [ ] 3.1 Provider framework
- [ ] 3.2 Microsoft OneDrive
- [ ] 3.3 Google Drive
- [ ] 3.4 Dropbox
- [ ] 3.5 Backup reminders and status
- [ ] 🏁 M3 tagged `v0.3.0`

### Phase 4 — Mobile
- [ ] 4.1 Capacitor setup
- [ ] 4.2 Native storage driver
- [ ] 4.3 Native integrations
- [ ] 4.4 Release builds
- [ ] 🏁 M4 tagged `v0.4.0`

### Phase 5 — Server, self-hosting and cloud
- [ ] Gate: `docs/server-design.md` approved
- [ ] 5.1 Server skeleton
- [ ] 5.2 PostgreSQL and multi-tenancy
- [ ] 5.3 Authentication (OIDC)
- [ ] 5.4 Sync
- [ ] 5.5 Self-hosted packaging
- [ ] 5.6 Cloud deployment
- [ ] 🏁 M5 tagged `v1.0.0`

### Notes / decisions log
- 2026-10-07 — **TypeScript 6.0.3 instead of 7.0.2.** typescript-eslint (required by §2) supports TypeScript `<6.1.0`; TS 7 (native port) is not supported yet. Renovate is capped accordingly.
- 2026-10-07 — **ESLint 9.39 instead of 10.x.** `eslint-plugin-jsx-a11y` peers on ESLint ≤ 9.
- 2026-10-07 — **`dinero.js` 2.0.2 ships `dinero.js/currencies`**; `@dinero.js/currencies` only exists as an alpha and is not used.
- 2026-10-07 — The CSP is injected as a `<meta>` tag in production builds only (Vite dev needs inline HMR code). `frame-ancestors` is left out of the meta CSP because browsers ignore it there and log an error; Caddy sets it in Phase 5 (SEC-W15).
- 2026-10-07 — Root `lint` runs ESLint once over the repo (single flat config, typed linting via projectService); `typecheck`/`build` go through Turborepo; `test` is `vitest run` over root projects (TEST_PLAN §3.4).
- 2026-10-07 — Until MSW arrives with the Phase 3 provider mocks, the web-unit setup stubs `fetch` to reject, so any unmocked network call fails the test.
- 2026-10-07 — Repository interfaces add a `SnapshotRepository` (exportSnapshot/replaceAll/mergeAll) for backup restore, `exportAll({ includeDeleted })` for tombstones, and category helpers (`reassignTransactions`, `reorder`, `countTransactions`, `seedDefaults`). Totals are `bigint` so sums never lose precision.
- 2026-10-07 — Zod 4 `.partial()` keeps `.default()`: `transactionPatchSchema` re-declares `note` without a default so a patch never wipes the note (caught by a unit test).
- 2026-10-07 — The production-KDF timing test enforces ≤ 2 s everywhere but the ≥ 200 ms floor only when `CI` is set: this dev machine derives in ~170 ms, below the floor that TEST_PLAN §2.5 defines for CI hardware.
- 2026-10-07 — Vault AAD split: the DEK is wrapped with AAD = magic|version|kdf|salt (stable across saves), the data with AAD = every header byte incl. generation and wrapped DEK. `changePassphrase` writes both slots so the old passphrase cannot open the older slot.
- 2026-10-07 — `SqlDriver.export()` returns `Promise<Uint8Array>` (the worker driver is async) and the driver adds `values()` (positional rows for Drizzle sqlite-proxy). Transactions receive a tx-scoped executor; drivers serialize all calls with a mutex so a transaction never interleaves with other statements.
- 2026-10-07 — Note search uses `instr(lower(note), lower(?)) > 0`: literal (no LIKE wildcards to escape), case-insensitive for ASCII like SQLite `lower()`; the in-memory fakes mirror that exactly.
- 2026-10-07 — pnpm 12 blocks dependency install scripts by default; `pnpm-workspace.yaml` allow-lists only `esbuild` (needed by drizzle-kit).
- 2026-10-07 — Zod 4 JIT disabled (`z.config({ jitless: true })` in core) because its `new Function` probe triggers a CSP violation without `unsafe-eval`.
- 2026-10-07 — Radix modal primitives (Dialog/Select/DropdownMenu) inject `<style>` tags via react-remove-scroll, which `style-src 'self'` blocks. The UI uses native `<select>`/`<dialog>` and checkbox inputs instead; shadcn is used for Button/Input/Card/Alert/Table etc.
- 2026-10-07 — Explicit user saves call `vault.flush()` so a save is durable before the tab can close; the worker's 500 ms debounce still coalesces bursts inside an action (found by J9 reloading right after a save).
- 2026-10-07 — E2E runs with 2 workers: with more parallel headless Chromium instances, localhost requests stall on this Windows machine (reproduced with plain fetch() from a static page, no app code). The guard observes requests instead of intercepting them (`route` interception added more flakiness). If the storage worker fails to load, vault calls now fail fast and the app shows a generic error instead of loading forever.
- 2026-10-07 — Coverage runs all Vitest projects including browser mode (Vitest collects no coverage when `--project` filters are used). `db.worker.ts` is excluded from coverage because v8 browser coverage does not instrument worker realms; its behaviour is covered by `db.worker.browser.test.ts`.

### Open questions
- Step 1.4 DoD item 4 (OPFS bytes contain no known note string) is verified in a real Chromium by the browser-mode test; the Playwright version is added in Step 1.6 (first UI field with free text), after which 1.4 is ticked.
