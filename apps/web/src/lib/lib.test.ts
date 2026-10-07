import { describe, expect, it, vi } from 'vitest';

import { applyTheme } from './theme';
import { defaultLocale, readUiPrefs, writeUiPrefs } from './ui-prefs';

describe('ui-prefs', () => {
  it('returns defaults when nothing is stored', () => {
    expect(readUiPrefs()).toEqual({ theme: 'system', locale: defaultLocale() });
  });

  it('round-trips theme and locale only', () => {
    writeUiPrefs({ theme: 'dark', locale: 'de-DE' });

    expect(readUiPrefs()).toEqual({ theme: 'dark', locale: 'de-DE' });
    expect(
      Object.keys(JSON.parse(localStorage.getItem('budget.ui-prefs') ?? '{}') as object),
    ).toEqual(['theme', 'locale']);
  });

  it.each([
    ['not json', { theme: 'system' }],
    [JSON.stringify({ theme: 'neon', locale: '<script>' }), { theme: 'system' }],
    [JSON.stringify({ theme: 'light', locale: 'x'.repeat(100) }), { theme: 'light' }],
  ])('ignores invalid stored values %j', (raw, expected) => {
    localStorage.setItem('budget.ui-prefs', raw);

    expect(readUiPrefs()).toMatchObject({ ...expected, locale: defaultLocale() });
  });

  it('survives storage being unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    expect(() => {
      writeUiPrefs({ theme: 'dark' });
    }).not.toThrow();
  });
});

describe('applyTheme', () => {
  it('toggles the dark class for explicit themes', () => {
    applyTheme('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    applyTheme('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('follows the system preference and listens for changes', () => {
    const listeners: Array<() => void> = [];
    let matches = true;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return matches;
        },
        addEventListener: (_: string, cb: () => void) => listeners.push(cb),
        removeEventListener: vi.fn(),
      })),
    );

    applyTheme('system');
    expect(document.documentElement).toHaveClass('dark');
    matches = false;
    listeners.forEach((cb) => {
      cb();
    });

    expect(document.documentElement).not.toHaveClass('dark');
  });
});
