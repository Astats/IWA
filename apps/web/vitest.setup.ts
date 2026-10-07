import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// Console guard (TEST_PLAN §3.2): any console.error/warn that a test did not expect fails it.
// Tests that expect one call `allowConsole()` first.
let consoleAllowed = false;
const consoleCalls: unknown[][] = [];

export function allowConsole(): void {
  consoleAllowed = true;
}

beforeEach(() => {
  consoleAllowed = false;
  consoleCalls.length = 0;
  for (const method of ['error', 'warn'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
  // No real network in tests: any unmocked fetch fails loudly.
  vi.stubGlobal('fetch', (input: unknown) =>
    Promise.reject(new Error(`Unmocked network request: ${String(input)}`)),
  );
});

afterEach(() => {
  cleanup();
  if (!consoleAllowed && consoleCalls.length > 0) {
    const first = consoleCalls[0]?.map(String).join(' ') ?? '';
    throw new Error(`Unexpected console output in test (${consoleCalls.length} call(s)): ${first}`);
  }
});
