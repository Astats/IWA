# Golden backup files

One committed backup per backup `format_version` (and per DB `schema_version`). They must restore forever (TEST_PLAN §2.4); never edit one, add a new one instead (`UPDATE_GOLDEN=1 pnpm vitest run --project backup`).

- Passphrase: `correct horse battery staple 2026` (test data only)
- KDF: production parameters (Argon2id m=64 MiB, t=3, p=1)
- `vN/golden.bgtb` + `vN/golden.expected.json` (decoded payload)
