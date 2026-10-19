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
    // Instants (e.g. when a backup was made) are shown in the user's own time zone.
    const dateTimeFormat = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const kbFormat = new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'kilobyte',
      maximumFractionDigits: 0,
    });
    const mbFormat = new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'megabyte',
      maximumFractionDigits: 1,
    });
    const compactFormat = new Intl.NumberFormat(locale, {
      notation: 'compact',
      maximumFractionDigits: 1,
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
      /** Formats an ISO 8601 instant as a local date and time. */
      dateTime: (iso: string) => dateTimeFormat.format(new Date(iso)),
      /** File sizes in KB below 1 MB, otherwise MB (decimal units). */
      fileSize: (bytes: number) =>
        bytes < 1_000_000
          ? kbFormat.format(Math.max(1, Math.round(bytes / 1000)))
          : mbFormat.format(bytes / 1_000_000),
      currencyName: (code: string) => currencyNames?.of(code) ?? code,
      /** Short axis labels (1.2K, 3M); chart geometry only, never exact amounts. */
      compact: (value: number) => compactFormat.format(value),
    };
  }, [locale]);
}
