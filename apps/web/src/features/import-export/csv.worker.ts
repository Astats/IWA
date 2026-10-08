import {
  CSV_LIMITS,
  CsvCollector,
  CsvFatalError,
  PAPA_OPTIONS,
  validateRows,
  type CsvParseOutcome,
} from '@budget/core/csv';
import { expose } from 'comlink';
import Papa from 'papaparse';

/*
 * CSV import worker (BUILD_PLAN 2.2): parses off the main thread so large files never freeze the
 * UI. The size limit is checked before reading; row and field limits are enforced while streaming
 * (parsing aborts as soon as a limit is hit).
 */

function parseFile(file: File): Promise<CsvParseOutcome> {
  if (file.size > CSV_LIMITS.maxBytes) {
    return Promise.resolve({ ok: false, code: 'TOO_LARGE', detail: [String(CSV_LIMITS.maxBytes)] });
  }
  if (file.size === 0) return Promise.resolve({ ok: false, code: 'EMPTY', detail: [] });
  const collector = new CsvCollector(CSV_LIMITS);
  const state: { fatal: CsvFatalError | null; delimiter: ',' | ';' } = {
    fatal: null,
    delimiter: ',',
  };
  return new Promise((resolve) => {
    Papa.parse<string[]>(file, {
      ...PAPA_OPTIONS,
      encoding: 'utf-8',
      chunkSize: 256 * 1024,
      step: (result, parser) => {
        if (state.fatal) return;
        state.delimiter = result.meta.delimiter === ';' ? ';' : ',';
        try {
          collector.push(result.data);
        } catch (err) {
          if (!(err instanceof CsvFatalError)) throw err;
          state.fatal = err;
          parser.abort();
        }
      },
      complete: () => {
        if (state.fatal) {
          resolve({ ok: false, code: state.fatal.code, detail: state.fatal.detail });
          return;
        }
        try {
          const collected = collector.result(state.delimiter);
          resolve({ ok: true, delimiter: collected.delimiter, ...validateRows(collected) });
        } catch (err) {
          if (!(err instanceof CsvFatalError)) throw err;
          resolve({ ok: false, code: err.code, detail: err.detail });
        }
      },
      error: () => {
        resolve({ ok: false, code: 'EMPTY', detail: [] });
      },
    });
  });
}

const api = { parseFile };
export type CsvWorkerApi = typeof api;

expose(api);
