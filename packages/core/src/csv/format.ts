/** CSV format v1 (BUILD_PLAN §4.4). */
export const CSV_COLUMNS = [
  'date',
  'kind',
  'amount',
  'currency',
  'category',
  'note',
  'id',
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];
export const REQUIRED_CSV_COLUMNS: readonly CsvColumn[] = [
  'date',
  'kind',
  'amount',
  'currency',
  'category',
];

export const BOM = '\ufeff';

export const CSV_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 50_000,
  maxFieldLength: 500,
} as const;

export type CsvLimits = { [K in keyof typeof CSV_LIMITS]: number };

/** Leading characters spreadsheet apps interpret as formulas (OWASP CSV injection). */
const FORMULA_START = /^\s*[=+\-@\t\r]/;

/**
 * Formula-injection protection: prefixes `'` when a cell (after leading whitespace) starts with
 * `= + - @ TAB CR`. Cells that already start with `'` are prefixed too, so {@link unescapeCell}
 * (which removes exactly one leading `'`) restores every value exactly.
 */
export function escapeCell(value: string): string {
  return FORMULA_START.test(value) || value.startsWith("'") ? `'${value}` : value;
}

export function unescapeCell(value: string): string {
  return value.startsWith("'") ? value.slice(1) : value;
}

/** RFC 4180 quoting: fields containing the delimiter, quotes, CR or LF are quoted, `"` doubled. */
export function quoteField(value: string, delimiter = ','): string {
  return value.includes(delimiter) || /["\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

export function csvLine(fields: readonly string[], delimiter = ','): string {
  return fields.map((f) => quoteField(escapeCell(f), delimiter)).join(delimiter);
}
