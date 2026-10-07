import i18n, { type Resource, type ResourceLanguage } from 'i18next';
import { initReactI18next } from 'react-i18next';

/**
 * Translation files are discovered automatically: adding `locales/<lang>.json` adds a language
 * without code changes (N6). English is the fallback for missing keys.
 */
const files = import.meta.glob<{ default: ResourceLanguage }>('./locales/*.json', { eager: true });

export const resources: Resource = Object.fromEntries(
  Object.entries(files).map(([path, mod]) => [
    path.replace(/^.*\/([\w-]+)\.json$/, '$1'),
    { translation: mod.default },
  ]),
);

export const TRANSLATED_LANGUAGES = Object.keys(resources);

/** Locales offered for formatting; UI text uses the closest translated language. */
export const LOCALE_OPTIONS = [
  'en-US',
  'en-GB',
  'de-DE',
  'fr-FR',
  'es-ES',
  'it-IT',
  'lv-LV',
  'ja-JP',
] as const;

export function initI18n(locale: string, extraResources: Resource = {}) {
  void i18n.use(initReactI18next).init({
    resources: { ...resources, ...extraResources },
    lng: locale,
    fallbackLng: 'en',
    load: 'languageOnly',
    // React escapes rendered text; i18next must not double-escape.
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
  document.documentElement.lang = locale;
  return i18n;
}

export function changeLocale(locale: string): void {
  void i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
}

export { i18n };
