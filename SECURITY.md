# Security

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Report them privately to the maintainer via GitHub's "Report a vulnerability" (private security advisory) on this repository. Include steps to reproduce, affected version/commit and impact. You will get an acknowledgement within 7 days.

## Threat model (STRIDE)

### Assets
- Financial data (transactions, notes, categories, settings)
- The user's passphrase and the keys derived from it (KEK, DEK)
- OAuth tokens for cloud backup providers (Phase 3)
- Backup files (local and cloud)

### Trust boundaries
- Browser page (main thread) ↔ storage Web Worker (holds the DEK)
- Web app ↔ browser storage (OPFS / IndexedDB): storage is untrusted, only ciphertext is written
- Web app ↔ imported files (CSV, backup): untrusted input
- Web app ↔ cloud providers (Phase 3): untrusted storage, only ciphertext is uploaded

### Threats and mitigations
_To be completed as features land._

| STRIDE | Threat | Mitigation |
| --- | --- | --- |
| Spoofing | | |
| Tampering | | |
| Repudiation | | |
| Information disclosure | | |
| Denial of service | | |
| Elevation of privilege | | |

## Cryptography summary
_To be completed in Step 1.2._

## Content Security Policy allow-list
_To be completed in Step 1.5._

| Origin | Directive | Justification |
| --- | --- | --- |
| `'self'` | all | The app is fully self-hosted; no third-party runtime origins. |
