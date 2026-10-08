import type { Category, Transaction } from '../domain';
import { minorToDecimal } from '../money';

import { BOM, CSV_COLUMNS, csvLine } from './format';

/**
 * Serializes transactions as CSV v1 (BUILD_PLAN §4.4): UTF-8 with BOM, `,` delimiter, CRLF line
 * ends, header `date,kind,amount,currency,category,note,id`, amounts as positive plain decimals
 * with `.`, and formula-injection escaping on every text cell. Pure function.
 */
export function exportTransactionsCsv(
  transactions: Iterable<Transaction>,
  categories: ReadonlyMap<string, Pick<Category, 'name'>>,
): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const t of transactions) {
    lines.push(
      csvLine([
        t.date,
        t.kind,
        minorToDecimal(t.amountMinor, t.currency),
        t.currency,
        categories.get(t.categoryId)?.name ?? '',
        t.note,
        t.id,
      ]),
    );
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

export interface CsvErrorRow {
  row: number;
  field: string;
  message: string;
}

/** CSV of import errors (row, field, message) for download from the preview screen. */
export function exportErrorsCsv(errors: readonly CsvErrorRow[]): string {
  const lines = [
    'row,field,message',
    ...errors.map((e) => csvLine([String(e.row), e.field, e.message])),
  ];
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
