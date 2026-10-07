import { daysInMonth, isValidIsoDate, type DateRange } from './domain';

export const DATE_PRESETS = [
  'this-month',
  'last-month',
  'this-year',
  'last-12-months',
  'custom',
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

interface YMD {
  y: number;
  m: number; // 1-12
  d: number;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function fmt({ y, m, d }: YMD): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Local calendar date (no time zone) of `now`, as YYYY-MM-DD. */
export function toLocalIsoDate(now: Date): string {
  return fmt({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
}

function parse(date: string): YMD {
  if (!isValidIsoDate(date)) throw new RangeError(`Invalid date: ${date}`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

/** Adds `delta` months to a (year, month) pair. */
function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const index = y * 12 + (m - 1) + delta;
  return { y: Math.floor(index / 12), m: (index % 12) + 1 };
}

export function monthRange(y: number, m: number): DateRange {
  return { dateFrom: fmt({ y, m, d: 1 }), dateTo: fmt({ y, m, d: daysInMonth(y, m) }) };
}

/**
 * Date range for a preset relative to `today` (a local calendar date, YYYY-MM-DD). Pure calendar
 * arithmetic on Y/M/D integers, so DST transitions and time zones cannot shift the boundaries.
 */
export function presetRange(preset: Exclude<DatePreset, 'custom'>, today: string): DateRange {
  const { y, m } = parse(today);
  switch (preset) {
    case 'this-month':
      return monthRange(y, m);
    case 'last-month': {
      const p = shiftMonth(y, m, -1);
      return monthRange(p.y, p.m);
    }
    case 'this-year':
      return { dateFrom: fmt({ y, m: 1, d: 1 }), dateTo: fmt({ y, m: 12, d: 31 }) };
    case 'last-12-months': {
      const start = shiftMonth(y, m, -11);
      return { dateFrom: fmt({ y: start.y, m: start.m, d: 1 }), dateTo: monthRange(y, m).dateTo };
    }
  }
}

/** Validates a user-chosen custom range. Returns null when invalid or reversed. */
export function customRange(dateFrom: string, dateTo: string): DateRange | null {
  if (!isValidIsoDate(dateFrom) || !isValidIsoDate(dateTo) || dateFrom > dateTo) return null;
  return { dateFrom, dateTo };
}

export interface MonthBucket extends DateRange {
  /** YYYY-MM */
  month: string;
}

/** The `count` calendar months ending with the month of `today`, oldest first. */
export function lastMonths(today: string, count: number): MonthBucket[] {
  const { y, m } = parse(today);
  return Array.from({ length: count }, (_, i) => {
    const p = shiftMonth(y, m, i - (count - 1));
    return { month: `${pad(p.y, 4)}-${pad(p.m)}`, ...monthRange(p.y, p.m) };
  });
}
