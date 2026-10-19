import type { BackupProvider } from '@budget/backup';
import { FakeBackupProvider } from '@budget/backup/testing';

declare global {
  interface Window {
    __E2E_HOOKS__?: { fakeProvider: FakeBackupProvider };
  }
}

/**
 * e2e build only (`vite build --mode e2e`). Never part of a production bundle: main.tsx imports
 * this module behind `import.meta.env.MODE === 'e2e'`, and verify-build fails if the marker
 * `__E2E_HOOKS__` appears in dist/. Tests use the handle to inject provider failures.
 */
export function installE2eHooks(): BackupProvider[] {
  const fakeProvider = new FakeBackupProvider({ latencyMs: 50 });
  window.__E2E_HOOKS__ = { fakeProvider };
  return [fakeProvider];
}
