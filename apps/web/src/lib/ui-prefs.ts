import { THEMES, type Theme } from '@budget/core';

/*
 * The ONLY module allowed to use Web Storage (lint-enforced). It stores the theme and language so
 * the locked screens render correctly before the vault is decrypted. Never store anything else.
 */

const KEY = 'budget.ui-prefs';

export interface UiPrefs {
  theme: Theme;
  locale: string;
}

/** True for a well-formed BCP 47 locale tag. */
function isLocale(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 35) return false;
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

export function defaultLocale(): string {
  const candidate = typeof navigator === 'undefined' ? 'en-US' : navigator.language;
  return isLocale(candidate) ? candidate : 'en-US';
}

export function readUiPrefs(): UiPrefs {
  const fallback: UiPrefs = { theme: 'system', locale: defaultLocale() };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Record<keyof UiPrefs, unknown>>;
    return {
      theme: THEMES.includes(parsed.theme as Theme) ? (parsed.theme as Theme) : fallback.theme,
      locale: isLocale(parsed.locale) ? parsed.locale : fallback.locale,
    };
  } catch {
    return fallback;
  }
}

export function writeUiPrefs(prefs: Partial<UiPrefs>): void {
  try {
    const next = { ...readUiPrefs(), ...prefs };
    localStorage.setItem(KEY, JSON.stringify({ theme: next.theme, locale: next.locale }));
  } catch {
    // Storage may be unavailable (private mode); preferences then reset on reload.
  }
}
