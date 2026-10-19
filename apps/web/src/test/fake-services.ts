import { createProviderRegistry, type BackupProvider } from '@budget/backup';
import type { Repositories } from '@budget/core';
import { parseAndValidateCsv } from '@budget/core/csv';
import { createInMemoryRepositories, testKdfParams } from '@budget/core/testing';
import { vi } from 'vitest';

import type { AppServices, VaultResult, VaultService } from '@/di';

export const TEST_PASSPHRASE = 'tulip river quiet lamp 2026';

export interface FakeVaultOptions {
  hasVault?: boolean;
  unlocked?: boolean;
  passphrase?: string;
  repos?: Repositories;
  persisted?: boolean;
}

export interface FakeVault extends VaultService {
  state: { hasVault: boolean; unlocked: boolean; passphrase: string; failedAttempts: number };
  repos: Repositories;
}

/**
 * In-memory VaultService for component tests: same contract as the storage worker (generic
 * errors, progressive delay hints) without crypto or workers.
 */
export function createFakeVault(options: FakeVaultOptions = {}): FakeVault {
  const repos = options.repos ?? createInMemoryRepositories();
  const state = {
    hasVault: options.hasVault ?? true,
    unlocked: options.unlocked ?? true,
    passphrase: options.passphrase ?? TEST_PASSPHRASE,
    failedAttempts: 0,
  };
  const files = new Map<string, Uint8Array>();
  const vault: FakeVault = {
    state,
    repos,
    status: vi.fn(() =>
      Promise.resolve({
        hasVault: state.hasVault,
        unlocked: state.unlocked,
        storage: 'opfs' as const,
        failedAttempts: state.failedAttempts,
      }),
    ),
    createVault: vi.fn((passphrase: string): Promise<VaultResult> => {
      if (state.hasVault) return Promise.resolve({ ok: false, error: 'VAULT_EXISTS' });
      Object.assign(state, { hasVault: true, unlocked: true, passphrase });
      return Promise.resolve({ ok: true });
    }),
    unlock: vi.fn((passphrase: string): Promise<VaultResult> => {
      if (passphrase !== state.passphrase) {
        state.failedAttempts++;
        return Promise.resolve({
          ok: false,
          error: 'WRONG_PASSPHRASE',
          retryAfterMs: 1000 * 2 ** (state.failedAttempts - 1),
        });
      }
      state.unlocked = true;
      state.failedAttempts = 0;
      return Promise.resolve({ ok: true });
    }),
    lock: vi.fn(() => {
      state.unlocked = false;
      return Promise.resolve();
    }),
    changePassphrase: vi.fn((oldP: string, newP: string): Promise<VaultResult> => {
      if (oldP !== state.passphrase)
        return Promise.resolve({ ok: false, error: 'WRONG_PASSPHRASE' });
      state.passphrase = newP;
      return Promise.resolve({ ok: true });
    }),
    verifyPassphrase: vi.fn((p: string) => Promise.resolve(p === state.passphrase)),
    flush: vi.fn(() => Promise.resolve()),
    saveFile: vi.fn((name: string, bytes: Uint8Array) => {
      files.set(name, bytes);
      return Promise.resolve();
    }),
    readFile: vi.fn((name: string) => Promise.resolve(files.get(name) ?? null)),
    createRepositories: () => repos,
    requestPersistentStorage: vi.fn(() => Promise.resolve(options.persisted ?? true)),
  };
  return vault;
}

export function createFakeServices(
  options: FakeVaultOptions & { now?: Date; route?: string; providers?: BackupProvider[] } = {},
): AppServices & { vault: FakeVault } {
  const now = options.now ?? new Date('2026-03-15T10:00:00Z');
  return {
    vault: createFakeVault(options),
    // Same pure parse/validate pipeline the worker runs, without a worker.
    parseCsv: async (file) => parseAndValidateCsv(await file.text()),
    kdfParams: testKdfParams,
    appVersion: '0.0.0-test',
    backupProviders: createProviderRegistry(options.providers ?? []),
    now: () => new Date(now),
  };
}
