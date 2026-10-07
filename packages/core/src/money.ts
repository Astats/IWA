import * as dineroBig from 'dinero.js/bigint';
import type { Dinero, DineroCurrency } from 'dinero.js/bigint';

/** Upper bound for a single amount in minor units (BUILD_PLAN §4.1). */
export const MAX_AMOUNT_MINOR = 10 ** 13;

type BigCurrency = DineroCurrency<bigint>;

const CURRENCIES: ReadonlyMap<string, BigCurrency> = new Map(
  Object.values(dineroBig)
    .filter(
      (v): v is BigCurrency =>
        typeof v === 'object' && 'code' in v && 'exponent' in v && typeof v.code === 'string',
    )
    .map((c) => [c.code, c]),
);

/** ISO 4217 codes known to the app, sorted. */
export const SUPPORTED_CURRENCIES: readonly string[] = [...CURRENCIES.keys()].sort();

export function isSupportedCurrency(code: string): boolean {
  return CURRENCIES.has(code);
}

function currencyOf(code: string): BigCurrency {
  const c = CURRENCIES.get(code);
  if (!c) throw new RangeError(`Unsupported currency: ${code}`);
  return c;
}

/** Number of minor-unit digits (JPY 0, EUR 2, KWD 3). */
export function currencyExponent(code: string): number {
  return Number(currencyOf(code).exponent);
}

export type AmountParseErrorCode =
  'EMPTY' | 'INVALID' | 'NEGATIVE' | 'ZERO' | 'TOO_MANY_DECIMALS' | 'TOO_LARGE';

export class AmountParseError extends Error {
  override readonly name = 'AmountParseError';

  constructor(readonly code: AmountParseErrorCode) {
    super(`Invalid amount: ${code}`);
  }
}

export type SafeAmountResult =
  { ok: true; amountMinor: number } | { ok: false; error: AmountParseErrorCode };

interface Separators {
  decimal: string;
  groups: string[];
}

const separatorCache = new Map<string, Separators>();

function separatorsFor(locale: string): Separators {
  const cached = separatorCache.get(locale);
  if (cached) return cached;
  const parts = new Intl.NumberFormat(locale).formatToParts(1234567.5);
  const decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.';
  const group = normalizeSpaces(parts.find((p) => p.type === 'group')?.value ?? ',');
  // Space-like group separators (fr: U+202F, lv/ru: U+00A0) are typed as plain spaces too.
  const groups = group === ' ' ? [' '] : [group];
  if (group === '’' || group === "'") groups.push("'", '’');
  const result = { decimal, groups };
  separatorCache.set(locale, result);
  return result;
}

function normalizeSpaces(s: string): string {
  return s.replace(/[\s\u00a0\u202f\u2007\u2009]/g, ' ');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Converts a plain decimal string ("1234.56", "1.234,56", ...) to minor units with integer math
 * only. `decimal` is the decimal separator; `groups` are allowed thousands separators (grouping
 * must be well-formed: 1-3 leading digits, then groups of 2-3 digits ending with a group of 3).
 */
export function decimalToMinor(
  input: string,
  currency: string,
  decimal: string,
  groups: readonly string[] = [],
): SafeAmountResult {
  const exponent = currencyExponent(currency);
  const s = normalizeSpaces(input).trim();
  if (s === '') return { ok: false, error: 'EMPTY' };
  if (/^[-−‒–(]|[-−)]$/.test(s)) return { ok: false, error: 'NEGATIVE' };

  const d = escapeRegExp(decimal);
  // Patterns are built from regex-escaped locale separators only.
  // eslint-disable-next-line security/detect-non-literal-regexp
  const plain = new RegExp(`^(\\d+)?(?:${d}(\\d+))?$`);
  let match = plain.exec(s);
  if (!match && groups.length > 0) {
    const g = `(?:${groups.map(escapeRegExp).join('|')})`;
    // Groups of 3 (1,234,567) or Indian-style 2s before the last 3 (12,34,567).
    // eslint-disable-next-line security/detect-non-literal-regexp
    const grouped = new RegExp(`^(\\d{1,3}(?:${g}\\d{2,3})*${g}\\d{3})(?:${d}(\\d+))?$`);
    match = grouped.exec(s);
  }
  const intRaw = match?.[1];
  const fracRaw = match?.[2] ?? '';
  if (!match || (intRaw === undefined && fracRaw === '')) return { ok: false, error: 'INVALID' };

  if (fracRaw.length > exponent) return { ok: false, error: 'TOO_MANY_DECIMALS' };
  const intDigits = (intRaw ?? '0').replace(/\D/g, '');
  const minor = BigInt(intDigits + fracRaw.padEnd(exponent, '0'));
  if (minor === 0n) return { ok: false, error: 'ZERO' };
  if (minor > BigInt(MAX_AMOUNT_MINOR)) return { ok: false, error: 'TOO_LARGE' };
  return { ok: true, amountMinor: Number(minor) };
}

/**
 * Parses a user-typed, locale-formatted amount ("1,234.56" in en-US, "1 234,56" in fr-FR) into
 * positive integer minor units. A currency symbol or ISO code is ignored. Rejects negative values,
 * zero, NaN/Infinity, exponents, malformed grouping, too many decimals and amounts > 10^13.
 */
export function safeParseAmount(input: string, currency: string, locale: string): SafeAmountResult {
  const { decimal, groups } = separatorsFor(locale);
  const symbols = new Set([currency]);
  for (const display of ['symbol', 'narrowSymbol'] as const) {
    const part = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: display,
    })
      .formatToParts(1)
      .find((p) => p.type === 'currency');
    // Compare in NFKC like the input (ja-JP uses the full-width ￥).
    if (part) symbols.add(part.value.normalize('NFKC'));
  }
  let s = normalizeSpaces(input.normalize('NFKC'));
  for (const sym of [...symbols].sort((a, b) => b.length - a.length)) {
    s = s.split(sym).join(' ');
  }
  // Strip the space(s) a currency symbol leaves behind, but keep inner spaces used for grouping.
  s = s.trim().replace(/^-\s+/, '-');
  return decimalToMinor(s, currency, decimal, groups);
}

export function parseAmount(input: string, currency: string, locale: string): number {
  const result = safeParseAmount(input, currency, locale);
  if (!result.ok) throw new AmountParseError(result.error);
  return result.amountMinor;
}

function toDinero(amountMinor: number | bigint, currency: string): Dinero<bigint> {
  return dineroBig.dinero({ amount: BigInt(amountMinor), currency: currencyOf(currency) });
}

/** Exact decimal string for an amount in minor units ("1234.56", "-0.05", "100"). */
export function minorToDecimal(amountMinor: number | bigint, currency: string): string {
  return dineroBig.toDecimal(toDinero(amountMinor, currency));
}

export interface FormatAmountOptions {
  /** `currency` (default) shows the symbol; `decimal` shows only the number. */
  style?: 'currency' | 'decimal';
  signDisplay?: 'auto' | 'always' | 'exceptZero' | 'never';
}

/** Locale formatting of minor units without floating point (Intl formats the exact decimal string). */
export function formatAmount(
  amountMinor: number | bigint,
  currency: string,
  locale: string,
  options: FormatAmountOptions = {},
): string {
  const exponent = currencyExponent(currency);
  const formatter = new Intl.NumberFormat(locale, {
    style: options.style ?? 'currency',
    ...(options.style === 'decimal' ? {} : { currency }),
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
    signDisplay: options.signDisplay ?? 'auto',
  });
  return formatter.format(minorToDecimal(amountMinor, currency) as Intl.StringNumericLiteral);
}

export interface MoneyItem {
  amountMinor: number | bigint;
  currency: string;
}

/** Sums amounts per currency with exact (bigint) arithmetic. Keys are sorted currency codes. */
export function sumByCurrency(items: Iterable<MoneyItem>): Map<string, bigint> {
  const totals = new Map<string, Dinero<bigint>>();
  for (const item of items) {
    const value = toDinero(item.amountMinor, item.currency);
    const prev = totals.get(item.currency);
    totals.set(item.currency, prev ? dineroBig.add(prev, value) : value);
  }
  return new Map(
    [...totals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, d]) => [code, dineroBig.toSnapshot(d).amount]),
  );
}
