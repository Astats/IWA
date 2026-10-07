import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  AmountParseError,
  currencyExponent,
  decimalToMinor,
  formatAmount,
  isSupportedCurrency,
  MAX_AMOUNT_MINOR,
  minorToDecimal,
  parseAmount,
  safeParseAmount,
  sumByCurrency,
  SUPPORTED_CURRENCIES,
} from './money';

const NBSP = '\u00a0';
const NNBSP = '\u202f';

describe('currencies', () => {
  it.each([
    ['JPY', 0],
    ['EUR', 2],
    ['USD', 2],
    ['KWD', 3],
  ])('%s has %i decimals', (code, exponent) => {
    expect(currencyExponent(code)).toBe(exponent);
  });

  it('knows ISO 4217 codes and rejects unknown ones', () => {
    expect(SUPPORTED_CURRENCIES.length).toBeGreaterThan(100);
    expect(isSupportedCurrency('EUR')).toBe(true);
    expect(isSupportedCurrency('XYZ')).toBe(false);
    expect(() => currencyExponent('XYZ')).toThrow(RangeError);
  });
});

describe('parseAmount', () => {
  it.each([
    // input, currency, locale, expected minor units
    ['1234.56', 'EUR', 'en-US', 123456],
    ['1,234.56', 'EUR', 'en-US', 123456],
    ['1.234,56', 'EUR', 'de-DE', 123456],
    ['1234,56', 'EUR', 'de-DE', 123456],
    [`1${NNBSP}234,56`, 'EUR', 'fr-FR', 123456],
    ['1 234,56', 'EUR', 'fr-FR', 123456],
    [`1${NBSP}234,56`, 'EUR', 'lv-LV', 123456],
    ['1 234,56', 'EUR', 'lv-LV', 123456],
    ['0.01', 'EUR', 'en-US', 1],
    ['.5', 'EUR', 'en-US', 50],
    ['12', 'EUR', 'en-US', 1200],
    ['12.5', 'EUR', 'en-US', 1250],
    ['  42.10  ', 'EUR', 'en-US', 4210],
    ['007.00', 'EUR', 'en-US', 700],
    ['1500', 'JPY', 'ja-JP', 1500],
    ['1,500', 'JPY', 'en-US', 1500],
    ['1.234', 'KWD', 'en-US', 1234],
    ['1,234.567', 'KWD', 'en-US', 1234567],
    ['0.001', 'KWD', 'en-US', 1],
    ['€1,234.56', 'EUR', 'en-US', 123456],
    ['1.234,56 €', 'EUR', 'de-DE', 123456],
    ['EUR 10.00', 'EUR', 'en-US', 1000],
    ['$5.25', 'USD', 'en-US', 525],
    ['12,34,567.00', 'INR', 'en-IN', 123456700],
    ['１２３', 'EUR', 'en-US', 12300], // full-width digits are normalized (NFKC)
  ])('parses %j (%s, %s) to %i', (input, currency, locale, expected) => {
    expect(parseAmount(input, currency, locale)).toBe(expected);
  });

  it('accepts the maximum amount 10^13 minor units and rejects one more', () => {
    expect(parseAmount('100000000000.00', 'EUR', 'en-US')).toBe(MAX_AMOUNT_MINOR);
    expect(parseAmount('10000000000000', 'JPY', 'en-US')).toBe(MAX_AMOUNT_MINOR);
    expect(safeParseAmount('100000000000.01', 'EUR', 'en-US')).toEqual({
      ok: false,
      error: 'TOO_LARGE',
    });
    expect(safeParseAmount('99999999999999999999999', 'EUR', 'en-US')).toEqual({
      ok: false,
      error: 'TOO_LARGE',
    });
  });

  it.each([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['0', 'ZERO'],
    ['0.00', 'ZERO'],
    ['-1', 'NEGATIVE'],
    ['-0.01', 'NEGATIVE'],
    ['−5', 'NEGATIVE'],
    ['(5.00)', 'NEGATIVE'],
    ['5-', 'NEGATIVE'],
    ['-€5.00', 'NEGATIVE'],
    ['NaN', 'INVALID'],
    ['Infinity', 'INVALID'],
    ['-Infinity', 'NEGATIVE'],
    ['1e5', 'INVALID'],
    ['1E-2', 'INVALID'],
    ['0x10', 'INVALID'],
    ['+5', 'INVALID'],
    ['12.', 'INVALID'],
    ['1.2.3', 'INVALID'],
    ['1,23,4.00', 'INVALID'],
    ['12,34', 'INVALID'],
    ['abc', 'INVALID'],
    ['1.234', 'TOO_MANY_DECIMALS'],
    ['1.001', 'TOO_MANY_DECIMALS'],
  ])('rejects %j with %s (EUR, en-US)', (input, error) => {
    expect(safeParseAmount(input, 'EUR', 'en-US')).toEqual({ ok: false, error });
  });

  it.each([
    ['1.5', 'JPY', 'TOO_MANY_DECIMALS'],
    ['1.0', 'JPY', 'TOO_MANY_DECIMALS'],
    ['1.0001', 'KWD', 'TOO_MANY_DECIMALS'],
  ])('rejects %j for %s with %s', (input, currency, error) => {
    expect(safeParseAmount(input, currency, 'en-US')).toEqual({ ok: false, error });
  });

  it('distinguishes `1 234,56` (fr) from `1,234.56` (en) by locale', () => {
    expect(parseAmount('1 234,56', 'EUR', 'fr-FR')).toBe(123456);
    expect(parseAmount('1,234.56', 'EUR', 'en-US')).toBe(123456);
    expect(safeParseAmount('1,234.56', 'EUR', 'fr-FR').ok).toBe(false);
    expect(safeParseAmount('1 234,56', 'EUR', 'en-US').ok).toBe(false);
  });

  it('treats `1.234` as grouping in de-DE but too many decimals in en-US', () => {
    expect(parseAmount('1.234', 'EUR', 'de-DE')).toBe(123400);
    expect(safeParseAmount('1.234', 'EUR', 'en-US')).toEqual({
      ok: false,
      error: 'TOO_MANY_DECIMALS',
    });
  });

  it('throws a typed AmountParseError', () => {
    expect(() => parseAmount('-1', 'EUR', 'en-US')).toThrow(AmountParseError);
    try {
      parseAmount('abc', 'EUR', 'en-US');
    } catch (err) {
      expect(err).toBeInstanceOf(AmountParseError);
      expect((err as AmountParseError).code).toBe('INVALID');
    }
  });
});

describe('decimalToMinor', () => {
  it('parses CSV-style amounts with a given decimal separator', () => {
    expect(decimalToMinor('12.34', 'EUR', '.')).toEqual({ ok: true, amountMinor: 1234 });
    expect(decimalToMinor('12,34', 'EUR', ',')).toEqual({ ok: true, amountMinor: 1234 });
    expect(decimalToMinor('1,234.00', 'EUR', '.')).toEqual({ ok: false, error: 'INVALID' });
  });
});

describe('formatAmount', () => {
  it.each([
    [123456, 'EUR', 'en-US', '€1,234.56'],
    [123456, 'EUR', 'de-DE', `1.234,56${NBSP}€`],
    [123456, 'EUR', 'fr-FR', `1${NNBSP}234,56${NBSP}€`],
    [1500, 'JPY', 'en-US', '¥1,500'],
    [1234567, 'KWD', 'en-US', `KWD${NBSP}1,234.567`],
    [5, 'EUR', 'en-US', '€0.05'],
  ])('formats %i %s in %s as %j', (minor, currency, locale, expected) => {
    expect(formatAmount(minor, currency, locale)).toBe(expected);
  });

  it('formats negative bigint balances and plain decimals', () => {
    expect(formatAmount(-123456n, 'EUR', 'en-US')).toBe('-€1,234.56');
    expect(formatAmount(123456, 'EUR', 'en-US', { style: 'decimal' })).toBe('1,234.56');
    expect(formatAmount(5000, 'EUR', 'en-US', { signDisplay: 'always' })).toBe('+€50.00');
  });

  it('formats amounts beyond 2^53 exactly', () => {
    expect(formatAmount(12345678901234567891n, 'EUR', 'en-US', { style: 'decimal' })).toBe(
      '123,456,789,012,345,678.91',
    );
  });

  it('exposes the exact decimal string', () => {
    expect(minorToDecimal(123456, 'EUR')).toBe('1234.56');
    expect(minorToDecimal(1500, 'JPY')).toBe('1500');
    expect(minorToDecimal(1, 'KWD')).toBe('0.001');
  });
});

describe('sumByCurrency', () => {
  it('sums per currency and sorts by code', () => {
    const totals = sumByCurrency([
      { amountMinor: 100, currency: 'USD' },
      { amountMinor: 250, currency: 'EUR' },
      { amountMinor: 50, currency: 'USD' },
    ]);

    expect([...totals.entries()]).toEqual([
      ['EUR', 250n],
      ['USD', 150n],
    ]);
  });

  it('returns an empty map for no items', () => {
    expect(sumByCurrency([]).size).toBe(0);
  });

  it('never loses precision for 100,000 maximum-size items', () => {
    const items = Array.from({ length: 100_000 }, () => ({
      amountMinor: MAX_AMOUNT_MINOR,
      currency: 'EUR',
    }));

    const total = sumByCurrency(items).get('EUR');

    expect(total).toBe(100_000n * BigInt(MAX_AMOUNT_MINOR));
  });
});

describe('money properties', () => {
  const currencyArb = fc.constantFrom('EUR', 'USD', 'JPY', 'KWD', 'GBP', 'CHF');
  const localeArb = fc.constantFrom('en-US', 'de-DE', 'fr-FR', 'lv-LV', 'ja-JP', 'en-GB');
  const amountArb = fc.integer({ min: 1, max: MAX_AMOUNT_MINOR });

  it('parse(format(x)) === x for every valid amount, currency and locale', () => {
    fc.assert(
      fc.property(amountArb, currencyArb, localeArb, (amount, currency, locale) => {
        expect(parseAmount(formatAmount(amount, currency, locale), currency, locale)).toBe(amount);
      }),
      { numRuns: 500 },
    );
  });

  it('sum is commutative and associative', () => {
    const itemArb = fc.record({ amountMinor: amountArb, currency: fc.constantFrom('EUR', 'USD') });
    fc.assert(
      fc.property(fc.array(itemArb), fc.array(itemArb), fc.array(itemArb), (a, b, c) => {
        const flat = (m: Map<string, bigint>) => [...m.entries()];
        const ab = sumByCurrency([...a, ...b]);
        const ba = sumByCurrency([...b, ...a]);
        expect(flat(ab)).toEqual(flat(ba));
        const abThenC = sumByCurrency([
          ...[...ab].map(([currency, amountMinor]) => ({ currency, amountMinor })),
          ...c,
        ]);
        const bc = sumByCurrency([...b, ...c]);
        const aThenBc = sumByCurrency([
          ...a,
          ...[...bc].map(([currency, amountMinor]) => ({ currency, amountMinor })),
        ]);
        expect(flat(abThenC)).toEqual(flat(aThenBc));
      }),
    );
  });

  it('sum equals an independent BigInt sum', () => {
    fc.assert(
      fc.property(fc.array(amountArb, { maxLength: 200 }), (amounts) => {
        const expected = amounts.reduce((acc, n) => acc + BigInt(n), 0n);
        const actual = sumByCurrency(
          amounts.map((amountMinor) => ({ amountMinor, currency: 'EUR' })),
        );
        expect(actual.get('EUR') ?? 0n).toBe(expected);
      }),
    );
  });

  it('parsing arbitrary strings never throws from safeParseAmount', () => {
    fc.assert(
      fc.property(fc.string(), localeArb, currencyArb, (input, locale, currency) => {
        const result = safeParseAmount(input, currency, locale);
        if (result.ok) {
          expect(Number.isSafeInteger(result.amountMinor)).toBe(true);
          expect(result.amountMinor).toBeGreaterThan(0);
          expect(result.amountMinor).toBeLessThanOrEqual(MAX_AMOUNT_MINOR);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
