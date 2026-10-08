import type { Repositories, Transaction, TransactionQuery } from '@budget/core';
import { exportTransactionsCsv } from '@budget/core/csv';

import { downloadFile, timestampedName } from '@/lib/download';

const PAGE = 500;

/** Every transaction matching `query` (all pages), in the query's sort order. */
export async function collectTransactions(
  repos: Pick<Repositories, 'transactions'>,
  query: Omit<TransactionQuery, 'limit' | 'offset'>,
): Promise<Transaction[]> {
  const out: Transaction[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { items, total } = await repos.transactions.list({ ...query, limit: PAGE, offset });
    out.push(...items);
    if (out.length >= total || items.length === 0) return out;
  }
}

/** Builds the CSV for `transactions` and downloads it. Returns the number of rows exported. */
export async function downloadTransactionsCsv(
  repos: Pick<Repositories, 'categories'>,
  transactions: Iterable<Transaction> | AsyncIterable<Transaction>,
  now: Date,
): Promise<number> {
  const rows: Transaction[] = [];
  for await (const t of transactions) rows.push(t);
  const categories = new Map(
    (await repos.categories.list({ includeDeleted: true })).map((c) => [c.id, c]),
  );
  downloadFile(
    timestampedName('budget-transactions', 'csv', now),
    exportTransactionsCsv(rows, categories),
    'text/csv;charset=utf-8',
  );
  return rows.length;
}
