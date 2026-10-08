# Security

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Report them privately to the maintainer via GitHub's "Report a vulnerability" (private security advisory) on this repository. Include steps to reproduce, affected version/commit and impact. You will get an acknowledgement within 7 days.

## Threat model (STRIDE)

### Assets

- Financial data (transactions, notes, categories, settings)
- The user's passphrase and the keys derived from it (KEK, DEK)
- OAuth tokens for cloud backup providers (Phase 3)
- Backup files (local and cloud) and CSV exports

### Trust boundaries

- Browser page (main thread) ↔ storage Web Worker (holds the DEK)
- Web app ↔ browser storage (OPFS / IndexedDB): storage is untrusted, only ciphertext is written
- Web app ↔ imported files (CSV, backup): untrusted input
- Web app ↔ cloud providers (Phase 3): untrusted storage, only ciphertext is uploaded

### Threats and mitigations

| STRIDE                 | Threat                                                                        | Mitigation                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | Someone with access to the device opens the app                               | Passphrase-derived key (Argon2id), generic unlock errors, progressive delay after failed unlocks, auto-lock after inactivity, manual lock                                                                      |
| Tampering              | The stored vault, a backup or an imported file is modified                    | AES-GCM authentication with the header as AAD, A/B vault slots, typed errors that fail closed, Zod validation of every imported row and backup payload before any write                                        |
| Repudiation            | (single-user, local app)                                                      | Not applicable until the server phase (audit log in Phase 5)                                                                                                                                                   |
| Information disclosure | Data read from browser storage, Web Storage, URLs, logs or the DOM after lock | Only ciphertext at rest (OPFS/IndexedDB); Web Storage holds theme/language only; no search terms, notes or amounts in URLs; no data in logs; locking drops the DEK, clears the query cache and unmounts the UI |
| Information disclosure | XSS exfiltrates data from the unlocked app                                    | React text rendering only, lint bans HTML/code sinks, strict CSP without `unsafe-inline`/`unsafe-eval`, no third-party scripts, every e2e test fails on CSP violations                                         |
| Information disclosure | Spreadsheet formula injection from an exported CSV                            | Cells starting (after whitespace) with `= + - @ TAB CR` are prefixed with `'`                                                                                                                                  |
| Denial of service      | Crafted files (huge CSV, gzip bomb, absurd KDF parameters)                    | 5 MB / 50,000 rows / 500 chars per field for CSV (checked before and while parsing, in a worker), 200 MB decompression cap for backups, KDF parameter bounds                                                   |
| Elevation of privilege | Malicious or vulnerable dependency                                            | Pinned versions, committed lockfile, `pnpm audit`, OSV-Scanner, Semgrep, CodeQL, gitleaks; dependency install scripts denied by default (only `esbuild` allow-listed)                                          |

## Cryptography summary

All cryptography uses the Web Crypto API plus `hash-wasm` for Argon2id. No custom algorithms; randomness only from `crypto.getRandomValues`.

- **Key hierarchy (AD12).** passphrase (NFC-normalized, UTF-8) → **Argon2id** (m = 64 MiB, t = 3, p = 1, random 16-byte salt) → 256-bit **KEK** (non-extractable AES-GCM key, usages `wrapKey`/`unwrapKey` only) → unwraps a random 256-bit **DEK** (AES-256-GCM). After unwrapping, the DEK is a **non-extractable** `CryptoKey` held by the storage worker; `exportKey` on it fails. Raw KEK bytes are zeroed right after import.
- **Passphrase change** re-wraps the same DEK under a new KEK (fresh salt) and rewrites both vault slots, so the old passphrase stops working everywhere. Data is not re-encrypted.
- **Encryption.** AES-256-GCM with a fresh random 12-byte IV per encryption; IVs are never reused with a key. Any authentication failure raises a typed `DecryptionError` and never returns partial plaintext.
- **Vault file** (OPFS, IndexedDB fallback): `BGTV | version | generation | kdf_params | salt | wrapped_DEK | iv | ciphertext`. The DEK is wrapped with AAD = magic, version, KDF parameters and salt; the data is encrypted with AAD = the whole header (generation included). Two slots (A/B) are written alternately with an increasing generation; on open, the highest generation that authenticates wins, so a crash mid-write never loses the previous state.
- **Downgrade / DoS guard.** A header asking for KDF parameters below the production minimum is rejected (`KdfPolicyError`); absurdly high parameters are rejected by schema limits.
- **Backups (AD13)** (`budget-backup-YYYYMMDD-HHmmss.bgtb`): `BGTB | version | created_at | app_version | kdf_params | salt | iv | AES-256-GCM(gzip(JSON))`. The key is derived from the passphrase with Argon2id and a **fresh salt per backup**, so a backup can be restored on a new device; every header byte is AAD. Opening fails closed: wrong passphrase or tampering → `DecryptionError`; malformed file → `FormatError`; newer format → `UnsupportedVersionError` with a clear message; weak KDF parameters → `KdfPolicyError`; decompressed size over 200 MB (gzip bomb) or contents failing Zod validation → `BackupPayloadError`. Nothing is written before the payload validates; replace and merge each run in one DB transaction, and an encrypted pre-restore backup is saved first.
- **CSV exports are not encrypted** (the user asks for a spreadsheet file); the UI says so.

## Content Security Policy allow-list

The production build carries this policy as a `<meta http-equiv="Content-Security-Policy">` tag (source: `apps/web/csp.mjs`; checked by `scripts/verify-build.mjs` and by the e2e guard, which fails on any `securitypolicyviolation`):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:;
font-src 'self'; worker-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none';
base-uri 'none'; form-action 'self'; upgrade-insecure-requests
```

| Origin / keyword     | Directive  | Justification                                                                                                           |
| -------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `'self'`             | all        | The app, its fonts, the SQLite WASM module, the workers and the service worker are served from the app origin. No CDNs. |
| `'wasm-unsafe-eval'` | script-src | Required to compile WebAssembly (sqlite-wasm, hash-wasm Argon2id). It does **not** allow JavaScript `eval`.             |
| `data:`              | img-src    | Small inline images generated by UI libraries (icons).                                                                  |

Notes:

- No `'unsafe-inline'` or `'unsafe-eval'`. Zod's JIT (which probes `new Function`) is disabled globally (`jitless`), and UI components that inject `<style>` elements at runtime (Radix Dialog/Select scroll locking, toast libraries) are not used; native elements are used instead.
- `frame-ancestors 'none'` cannot be delivered in a meta tag (browsers ignore it there). The reverse proxy will send it as an HTTP header in Phase 5 (SEC-W15).
- Cloud-backup provider origins are added to `connect-src` only in the Phase 3 step that needs them, and listed here with a justification.
- The service worker precaches the app shell only; it never caches data or API responses.
