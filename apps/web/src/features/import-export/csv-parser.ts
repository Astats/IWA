import type { CsvParseOutcome } from '@budget/core/csv';
import { wrap } from 'comlink';

import type { CsvWorkerApi } from './csv.worker';

/** Parses a CSV file in a dedicated worker (one per file; terminated afterwards). */
export async function parseCsvInWorker(file: File): Promise<CsvParseOutcome> {
  const worker = new Worker(new URL('./csv.worker.ts', import.meta.url), {
    type: 'module',
    name: 'budget-csv',
  });
  try {
    return await wrap<CsvWorkerApi>(worker).parseFile(file);
  } finally {
    worker.terminate();
  }
}
