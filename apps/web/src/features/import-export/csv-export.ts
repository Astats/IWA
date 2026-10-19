import type { Repositories, Transaction, TransactionQuery } from '@budget/core';
import { exportTransactionsCsv } from '@budget/core/csv';

import { timestampedName } from '@/lib/download';
import type { PlatformService } from '@/platform';

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

/** Builds the CSV for `transactions` and saves it. Returns the number of rows exported. */
export async function downloadTransactionsCsv(
  platform: Pick<PlatformService, 'saveFile'>,
  repos: Pick<Repositories, 'categories'>,
  transactions: Iterable<Transaction> | AsyncIterable<Transaction>,
  now: Date,
): Promise<number> {
  const rows: Transaction[] = [];
  for await (const t of transactions) rows.push(t);
  const categories = new Map(
    (await repos.categories.list({ includeDeleted: true })).map((c) => [c.id, c]),
  );
  await platform.saveFile({
    name: timestampedName('budget-transactions', 'csv', now),
    content: exportTransactionsCsv(rows, categories),
    type: 'text/csv;charset=utf-8',
  });
  return rows.length;
}
