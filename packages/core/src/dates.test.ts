import { afterEach, describe, expect, it, vi } from 'vitest';

import { customRange, lastMonths, presetRange, toLocalIsoDate } from './dates';

afterEach(() => {
  vi.useRealTimers();
});

describe('presetRange', () => {
  it.each([
    ['this-month', '2026-03-15', '2026-03-01', '2026-03-31'],
    ['this-month', '2026-02-10', '2026-02-01', '2026-02-28'],
    ['this-month', '2024-02-10', '2024-02-01', '2024-02-29'],
    ['this-month', '2026-04-30', '2026-04-01', '2026-04-30'],
    ['last-month', '2026-03-31', '2026-02-01', '2026-02-28'],
    ['last-month', '2024-03-01', '2024-02-01', '2024-02-29'],
    ['last-month', '2026-01-15', '2025-12-01', '2025-12-31'],
    ['this-year', '2026-07-04', '2026-01-01', '2026-12-31'],
    ['last-12-months', '2026-03-15', '2025-04-01', '2026-03-31'],
    ['last-12-months', '2026-12-01', '2026-01-01', '2026-12-31'],
  ] as const)('%s for %s is %s..%s', (preset, today, from, to) => {
    expect(presetRange(preset, today)).toEqual({ dateFrom: from, dateTo: to });
  });

  it('rejects an invalid reference date', () => {
    expect(() => presetRange('this-month', '2026-02-30')).toThrow(RangeError);
  });
});

describe('customRange', () => {
  it('accepts valid ordered dates and rejects others', () => {
    expect(customRange('2026-01-01', '2026-01-31')).toEqual({
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
    });
    expect(customRange('2026-02-01', '2026-01-31')).toBeNull();
    expect(customRange('2026-02-30', '2026-03-01')).toBeNull();
  });
});

describe('lastMonths', () => {
  it('returns 12 month buckets ending with the current month, across a year rollover', () => {
    const months = lastMonths('2026-02-14', 12);

    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ month: '2025-03', dateFrom: '2025-03-01', dateTo: '2025-03-31' });
    expect(months[11]).toEqual({ month: '2026-02', dateFrom: '2026-02-01', dateTo: '2026-02-28' });
    expect(months.map((m) => m.month)).toContain('2026-01');
  });
});

describe('toLocalIsoDate', () => {
  it('uses the local calendar date', () => {
    expect(toLocalIsoDate(new Date(2026, 2, 15, 23, 59))).toBe('2026-03-15');
    expect(toLocalIsoDate(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });

  // These run in the core-tz-* projects with TZ=Europe/Riga and TZ=America/New_York.
  it.each([
    // Riga DST starts 2026-03-29 03:00 local; New York 2026-03-08 02:00 local.
    [new Date(2026, 2, 29, 0, 30), '2026-03-29'],
    [new Date(2026, 2, 29, 4, 0), '2026-03-29'],
    [new Date(2026, 2, 8, 1, 59), '2026-03-08'],
    [new Date(2026, 2, 8, 3, 1), '2026-03-08'],
    // DST ends: Riga 2026-10-25, New York 2026-11-01.
    [new Date(2026, 9, 25, 23, 59), '2026-10-25'],
    [new Date(2026, 10, 1, 0, 0), '2026-11-01'],
  ])('keeps the local date across DST transitions (%s)', (date, expected) => {
    expect(toLocalIsoDate(date)).toBe(expected);
  });

  it('computes presets correctly right after a DST switch at local midnight', () => {
    vi.useFakeTimers({ now: new Date(2026, 2, 29, 0, 5) });

    const today = toLocalIsoDate(new Date());

    expect(presetRange('this-month', today)).toEqual({
      dateFrom: '2026-03-01',
      dateTo: '2026-03-31',
    });
  });
});
