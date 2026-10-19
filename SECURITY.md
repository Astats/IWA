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
| Information disclosure | A cloud provider (or whoever controls the account) reads backups              | Backups are encrypted on the device before upload (AD13); providers only see ciphertext and file names with a timestamp. Provider sessions live in memory only and are dropped when the app locks              |
| Tampering              | A provider returns crafted listings or files                                  | Listings are Zod-validated (only `budget-backup-YYYYMMDD-HHmmss.bgtb` names are shown); downloaded files go through the same fail-closed backup checks as local files                                          |
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
default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client;
style-src 'self' https://accounts.google.com/gsi/style; img-src 'self' data:; font-src 'self';
worker-src 'self'; connect-src 'self' https://login.microsoftonline.com https://graph.microsoft.com
https://*.1drv.com https://*.sharepoint.com https://accounts.google.com/gsi/ https://www.googleapis.com
https://api.dropboxapi.com https://content.dropboxapi.com;
frame-src https://accounts.google.com/gsi/; manifest-src 'self'; object-src 'none'; base-uri 'none';
form-action 'self'; upgrade-insecure-requests
```

| Origin / keyword                         | Directive              | Justification                                                                                                                                                                       |
| ---------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'self'`                                 | all                    | The app, its fonts, the SQLite WASM module, the workers and the service worker are served from the app origin. No CDNs.                                                             |
| `'wasm-unsafe-eval'`                     | script-src             | Required to compile WebAssembly (sqlite-wasm, hash-wasm Argon2id). It does **not** allow JavaScript `eval`.                                                                         |
| `data:`                                  | img-src                | Small inline images generated by UI libraries (icons).                                                                                                                              |
| `https://login.microsoftonline.com`      | connect-src            | OneDrive (3.2): MSAL authority discovery and the token endpoint (authorization code + PKCE redemption). Sign-in itself runs in a popup window, which `connect-src` does not govern. |
| `https://graph.microsoft.com`            | connect-src            | OneDrive (3.2): Microsoft Graph calls on the app folder (list, upload, delete, file metadata).                                                                                      |
| `https://*.1drv.com`                     | connect-src            | OneDrive (3.2): pre-authenticated upload-session and download URLs that Graph returns for personal accounts (no bearer token is sent there).                                        |
| `https://*.sharepoint.com`               | connect-src            | OneDrive (3.2): the same upload/download URLs for work or school accounts (OneDrive for Business).                                                                                  |
| `https://accounts.google.com/gsi/client` | script-src             | Google Drive (3.3): the Google Identity Services library, the only third-party script. It is injected only when the Backup screen shows Google Drive (never on other screens).      |
| `https://accounts.google.com/gsi/style`  | style-src              | Google Drive (3.3): stylesheet GIS may load (Google's documented CSP for the library).                                                                                              |
| `https://accounts.google.com/gsi/`       | connect-src, frame-src | Google Drive (3.3): GIS endpoints and iframes, as documented by Google. The sign-in itself runs in a popup.                                                                         |
| `https://www.googleapis.com`             | connect-src            | Google Drive (3.3): Drive API v3 on the hidden app data folder, including multipart and resumable uploads.                                                                          |
| `https://api.dropboxapi.com`             | connect-src            | Dropbox (3.4): OAuth token endpoint (code + PKCE verifier) and the RPC API (list, delete) on the App folder.                                                                        |
| `https://content.dropboxapi.com`         | connect-src            | Dropbox (3.4): upload and download of backup files in the App folder.                                                                                                               |

Notes:

- No `'unsafe-inline'` or `'unsafe-eval'`. Zod's JIT (which probes `new Function`) is disabled globally (`jitless`), and UI components that inject `<style>` elements at runtime (Radix Dialog/Select scroll locking, toast libraries) are not used; native elements are used instead.
- `frame-ancestors 'none'` cannot be delivered in a meta tag (browsers ignore it there). The reverse proxy will send it as an HTTP header in Phase 5 (SEC-W15).
- Cloud-backup provider origins are added to `connect-src` only in the Phase 3 step that needs them, and listed here with a justification.
- The service worker precaches the app shell only; it never caches data or API responses. OAuth redirect pages (`/auth/callback/*`) are excluded from its navigation fallback.

## Cloud provider sign-in (OAuth)

- **OneDrive** uses `@azure/msal-browser`: authorization code flow with PKCE (S256) and `state` in a popup; the delegated scope is `Files.ReadWrite.AppFolder` only (MSAL adds the OpenID scopes `openid profile offline_access`). MSAL's token cache is `memoryStorage`, so access and refresh tokens never reach Web Storage or IndexedDB; MSAL only keeps a transient "interaction in progress" marker in `sessionStorage` during sign-in. The popup returns to `/auth/callback/microsoft`, a separate page that only runs MSAL's redirect bridge (it hands the response to the app over a `BroadcastChannel`); the app is not loaded there.
- **Google Drive** uses the Google Identity Services token client: Google's popup returns a short-lived access token for the scope `https://www.googleapis.com/auth/drive.appdata` only (checked with `hasGrantedAllScopes`). There is no client secret, no authorization code and therefore no PKCE in this model, and no refresh token: when the token expires (≈1 hour) the user connects again. The token is held in memory only.
- **Dropbox** uses the authorization code flow with PKCE (S256) for a public client (no app secret), implemented in `apps/web/src/cloud/`: the popup is opened from the click, navigated to Dropbox with a random `state`, and returns to `/auth/callback/dropbox`, a tiny page that posts `state` + `code` on a same-origin `BroadcastChannel`, removes them from the URL and closes. The app rejects any response whose `state` differs (no code exchange happens), validates the message with Zod, and asks only for `files.metadata.read files.content.read files.content.write` with `token_access_type=online` (short-lived access token, no refresh token). The app key's Dropbox app has "App folder" access, so the token cannot reach the rest of the user's Dropbox.
- Sessions are memory-only: reloading or locking the app (auto-lock included) forgets every provider session. A 401 from a provider forgets the session and asks the user to connect again.
- Tokens are sent only to the provider's API origin; pre-authenticated upload/download URLs never receive them, and a listing that points to another origin is rejected.

## Test builds

The Playwright suite runs against `vite build --mode e2e` (output `apps/web/dist-e2e/`). That mode adds only an in-memory fake cloud provider (`apps/web/src/app/e2e-hooks.ts`, exposed as `window.__E2E_HOOKS__`) behind `import.meta.env.MODE === 'e2e'`. Production builds drop that branch; `scripts/verify-build.mjs` fails if the marker `__E2E_HOOKS__` appears in `dist/`, and ESLint forbids importing `@budget/backup/testing` anywhere else (SEC-W14).
