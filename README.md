# Budget App

A local-first, encrypted personal budget app. It runs fully offline as a web PWA and as Android/iOS apps (Capacitor), keeps all data encrypted at rest, and supports CSV import/export and encrypted backups.

See [BUILD_PLAN.md](BUILD_PLAN.md) for the roadmap and [TEST_PLAN.md](TEST_PLAN.md) for the test strategy. Security design and how to report vulnerabilities: [SECURITY.md](SECURITY.md).

## Requirements

- Node.js 24 LTS (see `.nvmrc`)
- pnpm 12 (`npm i -g pnpm@12` or `corepack enable`)

## Getting started

```bash
pnpm install
pnpm dev          # web app at http://localhost:5173
```

## Common scripts (run from the repo root)

| Script                              | What it does                                               |
| ----------------------------------- | ---------------------------------------------------------- |
| `pnpm dev`                          | Start the web app in dev mode                              |
| `pnpm build`                        | Production build of all packages/apps                      |
| `pnpm lint`                         | ESLint (flat config, includes security and boundary rules) |
| `pnpm typecheck`                    | `tsc --noEmit` in every package                            |
| `pnpm test`                         | All unit/component/integration tests (Vitest projects)     |
| `pnpm test:coverage`                | Same, with coverage thresholds enforced                    |
| `pnpm test:browser`                 | Vitest Browser Mode tests (real Chromium)                  |
| `pnpm test:e2e`                     | Playwright end-to-end tests against the production build   |
| `pnpm format` / `pnpm format:check` | Prettier                                                   |

## Mobile (Capacitor)

The native projects live in `apps/web/android` and `apps/web/ios` (appId `com.astats.budget`). Requirements: Android Studio with an Android SDK, and **JDK 21 or newer** for Gradle (Capacitor 8 compiles Java 21; Gradle 8.14 runs on JDK 21–24). iOS builds need a Mac with Xcode.

```bash
pnpm --filter web build
cd apps/web && npx cap sync    # copy dist/ into the native projects
npx cap open android           # or: cd android && ./gradlew assembleDebug
```

## Repository layout

```
packages/core     domain types, Zod schemas, money, repository interfaces, CSV (pure)
packages/crypto   key derivation, envelope encryption, vault file format
packages/db       SQLite schema/migrations, SqlDriver, repository implementations
packages/backup   encrypted backup file format
apps/web          React + Vite PWA; Capacitor projects in android/ and ios/
e2e/              Playwright tests
test-data/        static CSV/backup fixtures
```
