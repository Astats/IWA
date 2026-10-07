import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { createFakeServices } from '@/test/fake-services';
import { renderApp } from '@/test/render';

import { changeLocale, i18n, resources, TRANSLATED_LANGUAGES } from '.';

const PSEUDO = 'qps-ploc';

/** Pseudo-locale: wraps every translated string in ⟦…⟧ so untranslated literals stand out. */
function pseudo(value: unknown): unknown {
  if (typeof value === 'string') return `⟦${value}⟧`;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pseudo(v)]));
  }
  return value;
}

/** Text nodes rendered by the app that do not come from the translation files. */
function untranslatedText(root: HTMLElement): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const leaks: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? '';
    if (!text || node.parentElement?.closest('option, [data-i18n-ignore]')) continue;
    if (!text.includes('⟦')) leaks.push(text);
  }
  return leaks;
}

describe('i18n', () => {
  afterEach(() => {
    changeLocale('en-US');
  });

  it('discovers translation files automatically (no code change per language)', () => {
    expect(TRANSLATED_LANGUAGES).toContain('en');
  });

  it.each([
    ['onboarding', { hasVault: false, unlocked: false }, 'Get started'],
    ['unlock', { unlocked: false }, 'Unlock'],
    ['settings', { route: '/settings' }, 'Save'],
  ] as const)(
    '%s screen has no untranslated strings (pseudo-locale)',
    async (_name, options, button) => {
      // 'qps' is a reserved pseudo-locale language code, distinct from 'en'.
      i18n.addResourceBundle('qps', 'translation', pseudo(resources.en?.translation));
      changeLocale(PSEUDO);
      const services = createFakeServices(options);
      await services.vault.repos.settings.set('locale', PSEUDO);

      const app = renderApp({ ...options, services });
      await screen.findByRole('button', { name: `⟦${button}⟧` });

      expect(untranslatedText(app.container)).toEqual([]);
      expect(document.documentElement.lang).toBe(PSEUDO);
    },
  );
});
