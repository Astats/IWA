import { formatAmount, type FormatAmountOptions } from '@budget/core';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/** Locale-aware formatting via Intl, following the active language/region (N6). */
export function useFormatters() {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  return useMemo(() => {
    const dateFormat = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    const monthFormat = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
    let currencyNames: Intl.DisplayNames | null = null;
    try {
      currencyNames = new Intl.DisplayNames([locale], { type: 'currency' });
    } catch {
      currencyNames = null;
    }
    return {
      locale,
      money: (minor: number | bigint, currency: string, options?: FormatAmountOptions) =>
        formatAmount(minor, currency, locale, options),
      /** Formats a calendar date (YYYY-MM-DD) without shifting it by the time zone. */
      date: (isoDate: string) => dateFormat.format(new Date(`${isoDate}T00:00:00Z`)),
      /** Formats a YYYY-MM month. */
      month: (isoMonth: string) => monthFormat.format(new Date(`${isoMonth}-01T00:00:00Z`)),
      currencyName: (code: string) => currencyNames?.of(code) ?? code,
    };
  }, [locale]);
}
