import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import * as axeMatchers from 'vitest-axe/matchers';

import { initI18n } from '@/i18n';

expect.extend(axeMatchers);

initI18n('en-US');

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
  // jsdom has no ResizeObserver or layout: report a fixed size so chart containers can render.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        const contentRect = {
          width: 480,
          height: 256,
          top: 0,
          left: 0,
          bottom: 256,
          right: 480,
          x: 0,
          y: 0,
        };
        this.callback([{ target, contentRect } as unknown as ResizeObserverEntry], this);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom has no matchMedia (used by the theme switcher).
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  if (!consoleAllowed && consoleCalls.length > 0) {
    const first = consoleCalls[0]?.map(String).join(' ') ?? '';
    throw new Error(`Unexpected console output in test (${consoleCalls.length} call(s)): ${first}`);
  }
});
