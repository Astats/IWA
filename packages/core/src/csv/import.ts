import '../zod-config';

import Papa from 'papaparse';
import { z } from 'zod';

import {
  categoryNameSchema,
  currencySchema,
  idSchema,
  isoDateSchema,
  kindSchema,
  noteSchema,
  type Category,
  type Kind,
  type NewTransaction,
} from '../domain';
import { decimalToMinor, isSupportedCurrency } from '../money';
import type { Repositories } from '../repositories';

import {
  CSV_COLUMNS,
  CSV_LIMITS,
  REQUIRED_CSV_COLUMNS,
  unescapeCell,
  type CsvColumn,
  type CsvLimits,
} from './format';

/** File-level problems: the whole import is rejected (nothing is parsed further). */
export type CsvFatalCode = 'EMPTY' | 'TOO_LARGE' | 'TOO_MANY_ROWS' | 'MISSING_COLUMNS' | 'NO_ROWS';

export class CsvFatalError extends Error {
  override readonly name = 'CsvFatalError';

  constructor(
    readonly code: CsvFatalCode,
    readonly detail: string[] = [],
  ) {
    super(code);
  }
}

/** One problem in one row; `row` is the 1-based record number (the header is row 1). */
export interface ImportRowError {
  row: number;
  field: CsvColumn | 'row';
  code: string;
}

export interface CollectedCsv {
  delimiter: ',' | ';';
  /** Rows keyed by column name (unknown columns are ignored). */
  rows: Array<{ row: number; fields: Partial<Record<CsvColumn, string>> }>;
  errors: ImportRowError[];
}

/**
 * Incremental CSV row collector: enforces the row and field limits while parsing (so huge files
 * are rejected early) and maps columns by header name (case-insensitive, any order).
 */
export class CsvCollector {
  #columns: Partial<Record<CsvColumn, number>> | null = null;
  #rows: CollectedCsv['rows'] = [];
  #errors: ImportRowError[] = [];
  #record = 0;

  constructor(private readonly limits: CsvLimits = CSV_LIMITS) {}

  /** Adds one parsed record. Throws CsvFatalError for file-level problems. */
  push(fields: string[]): void {
    this.#record++;
    if (!this.#columns) {
      this.#columns = this.#readHeader(fields);
      return;
    }
    if (fields.length === 1 && fields[0]?.trim() === '') return; // blank line
    if (this.#rows.length >= this.limits.maxRows) {
      throw new CsvFatalError('TOO_MANY_ROWS', [String(this.limits.maxRows)]);
    }
    const mapped: Partial<Record<CsvColumn, string>> = {};
    let tooLong = false;
    for (const column of CSV_COLUMNS) {
      const index = this.#columns[column];
      if (index === undefined) continue;
      const value = fields[index] ?? '';
      if (value.length > this.limits.maxFieldLength) {
        tooLong = true;
        this.#errors.push({ row: this.#record, field: column, code: 'FIELD_TOO_LONG' });
      }
      mapped[column] = value;
    }
    if (!tooLong) this.#rows.push({ row: this.#record, fields: mapped });
  }

  #readHeader(fields: string[]): Partial<Record<CsvColumn, number>> {
    const columns: Partial<Record<CsvColumn, number>> = {};
    fields.forEach((raw, index) => {
      const name = raw
        .replace(/^\ufeff/, '')
        .trim()
        .toLowerCase();
      if (
        (CSV_COLUMNS as readonly string[]).includes(name) &&
        columns[name as CsvColumn] === undefined
      ) {
        columns[name as CsvColumn] = index;
      }
    });
    const missing = REQUIRED_CSV_COLUMNS.filter((c) => columns[c] === undefined);
    if (missing.length > 0) throw new CsvFatalError('MISSING_COLUMNS', missing);
    return columns;
  }

  result(delimiter: ',' | ';'): CollectedCsv {
    if (!this.#columns) throw new CsvFatalError('EMPTY');
    if (this.#rows.length === 0 && this.#errors.length === 0) throw new CsvFatalError('NO_ROWS');
    return { delimiter, rows: this.#rows, errors: this.#errors };
  }
}

/** Papa Parse options shared by string and streaming (worker) parsing. */
export const PAPA_OPTIONS: { delimitersToGuess: string[]; skipEmptyLines: 'greedy' } = {
  delimitersToGuess: [',', ';'],
  skipEmptyLines: 'greedy',
};

/** Parses CSV text (UTF-8, optional BOM) with all limits enforced. */
export function parseCsvText(text: string, limits: CsvLimits = CSV_LIMITS): CollectedCsv {
  if (new TextEncoder().encode(text).length > limits.maxBytes) {
    throw new CsvFatalError('TOO_LARGE', [String(limits.maxBytes)]);
  }
  const body = text.replace(/^\ufeff/, '');
  if (body.trim() === '') throw new CsvFatalError('EMPTY');
  const collector = new CsvCollector(limits);
  // Mutated inside the parser callback (TypeScript cannot track that for plain locals).
  const state: { fatal: CsvFatalError | null; delimiter: ',' | ';' } = {
    fatal: null,
    delimiter: ',',
  };
  Papa.parse<string[]>(body, {
    ...PAPA_OPTIONS,
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
  });
  if (state.fatal) throw state.fatal;
  return collector.result(state.delimiter);
}

/** A row that passed validation, before categories are resolved. */
export interface ValidImportRow {
  row: number;
  id?: string;
  date: string;
  kind: Kind;
  amountMinor: number;
  currency: string;
  categoryName: string;
  note: string;
}

const rowSchema = (decimal: ',' | '.') =>
  z
    .object({
      date: isoDateSchema,
      kind: z.string().trim().toLowerCase().pipe(kindSchema),
      currency: z.string().trim().toUpperCase().pipe(currencySchema),
      amount: z.string(),
      category: categoryNameSchema,
      note: z
        .string()
        .default('')
        .transform((v) => unescapeCell(v))
        .pipe(noteSchema),
      id: z
        .string()
        .trim()
        .transform((v) => (v === '' ? undefined : v.toLowerCase()))
        .pipe(idSchema.optional())
        .optional(),
    })
    .transform((v, ctx) => {
      if (!isSupportedCurrency(v.currency)) return z.NEVER;
      const amount = decimalToMinor(v.amount.trim(), v.currency, decimal);
      if (!amount.ok) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: `AMOUNT_${amount.error}` });
        return z.NEVER;
      }
      return { ...v, amountMinor: amount.amountMinor };
    });

const FIELD_CODES: Record<string, string> = {
  date: 'INVALID_DATE',
  kind: 'INVALID_KIND',
  currency: 'INVALID_CURRENCY',
  category: 'INVALID_CATEGORY',
  note: 'NOTE_TOO_LONG',
  id: 'INVALID_ID',
};

/**
 * Validates every collected row with Zod and collects all errors (never stops at the first).
 * The decimal comma is accepted only for `;`-delimited files (BUILD_PLAN §4.4).
 */
export function validateRows(collected: CollectedCsv): {
  valid: ValidImportRow[];
  errors: ImportRowError[];
} {
  const decimal = collected.delimiter === ';' ? ',' : '.';
  const schema = rowSchema(decimal);
  const valid: ValidImportRow[] = [];
  const errors: ImportRowError[] = [...collected.errors];
  for (const { row, fields } of collected.rows) {
    const result = schema.safeParse({ ...fields, category: unescapeCell(fields.category ?? '') });
    if (!result.success) {
      const seen = new Set<string>();
      for (const issue of result.error.issues) {
        const field = String(issue.path[0] ?? 'row');
        if (seen.has(field)) continue;
        seen.add(field);
        const code =
          field === 'amount' && issue.message.startsWith('AMOUNT_')
            ? issue.message
            : (FIELD_CODES[field] ?? 'INVALID');
        errors.push({
          row,
          field: (CSV_COLUMNS as readonly string[]).includes(field) ? (field as CsvColumn) : 'row',
          code,
        });
      }
      continue;
    }
    const v = result.data;
    valid.push({
      row,
      ...(v.id ? { id: v.id } : {}),
      date: v.date,
      kind: v.kind,
      amountMinor: v.amountMinor,
      currency: v.currency,
      categoryName: v.category,
      note: v.note,
    });
  }
  errors.sort((a, b) => a.row - b.row);
  return { valid, errors };
}

export interface ImportOptions {
  /** Skip rows that duplicate existing transactions (default true). */
  skipDuplicates: boolean;
  /** Create categories that do not exist yet (needs user confirmation; default false). */
  createCategories: boolean;
}

export interface ImportContext {
  categories: readonly Pick<Category, 'id' | 'name' | 'kind'>[];
  /** Ids of all existing transactions (including deleted ones). */
  existingIds: ReadonlySet<string>;
  /** Duplicate keys of existing, non-deleted transactions (see {@link duplicateKey}). */
  existingKeys: ReadonlySet<string>;
}

export interface ImportPlan {
  /** Rows that will be inserted (category resolved by name and kind). */
  rows: Array<{ row: number; categoryKey: string; input: Omit<NewTransaction, 'categoryId'> }>;
  duplicates: number[];
  /** Categories that must be created (when allowed). */
  newCategories: Array<{ name: string; kind: Kind }>;
  /** Rows skipped because their category does not exist and creation is not allowed. */
  missingCategoryRows: number[];
}

/** Duplicate key for rows without an id (BUILD_PLAN §4.4). */
export function duplicateKey(t: {
  date: string;
  kind: Kind;
  amountMinor: number;
  currency: string;
  note: string;
}): string {
  return JSON.stringify([t.date, t.kind, t.amountMinor, t.currency, t.note]);
}

const categoryKey = (kind: Kind, name: string) => `${kind}:${name.toLowerCase()}`;

/** Decides what an import would do, without writing anything. */
export function planImport(
  valid: readonly ValidImportRow[],
  ctx: ImportContext,
  options: ImportOptions,
): ImportPlan {
  const known = new Set(ctx.categories.map((c) => categoryKey(c.kind, c.name)));
  const plan: ImportPlan = { rows: [], duplicates: [], newCategories: [], missingCategoryRows: [] };
  const plannedNew = new Set<string>();
  const seenIds = new Set<string>();
  for (const r of valid) {
    const key = categoryKey(r.kind, r.categoryName);
    if (!known.has(key) && !options.createCategories) {
      plan.missingCategoryRows.push(r.row);
      continue;
    }
    const idTaken = r.id !== undefined && (ctx.existingIds.has(r.id) || seenIds.has(r.id));
    const isDuplicate = r.id !== undefined ? idTaken : ctx.existingKeys.has(duplicateKey(r));
    if (isDuplicate) {
      plan.duplicates.push(r.row);
      if (options.skipDuplicates) continue;
    }
    if (!known.has(key) && !plannedNew.has(key)) {
      plannedNew.add(key);
      plan.newCategories.push({ name: r.categoryName, kind: r.kind });
    }
    // A duplicate id cannot be inserted again; importing it anyway gets a fresh id.
    const keepId = r.id !== undefined && !idTaken;
    if (keepId && r.id) seenIds.add(r.id);
    plan.rows.push({
      row: r.row,
      categoryKey: key,
      input: {
        ...(keepId ? { id: r.id } : {}),
        kind: r.kind,
        amountMinor: r.amountMinor,
        currency: r.currency,
        date: r.date,
        note: r.note,
      },
    });
  }
  return plan;
}

/** Builds the {@link ImportContext} from the repositories (reads every transaction once). */
export async function loadImportContext(
  repos: Pick<Repositories, 'categories' | 'transactions'>,
): Promise<ImportContext> {
  const existingIds = new Set<string>();
  const existingKeys = new Set<string>();
  for await (const t of repos.transactions.exportAll({ includeDeleted: true })) {
    existingIds.add(t.id);
    if (t.deletedAt === null) existingKeys.add(duplicateKey(t));
  }
  return { categories: await repos.categories.list(), existingIds, existingKeys };
}

/**
 * Commits a plan: creates the needed categories, then inserts every row with one `bulkInsert`
 * (a single DB transaction: all rows or none). If the insert fails, categories created by this
 * import are removed again, so a failed import leaves no visible trace.
 */
export async function commitImport(
  repos: Pick<Repositories, 'categories' | 'transactions'>,
  plan: ImportPlan,
): Promise<number> {
  const ids = new Map(
    (await repos.categories.list()).map((c) => [categoryKey(c.kind, c.name), c.id]),
  );
  const created: string[] = [];
  try {
    for (const c of plan.newCategories) {
      const key = categoryKey(c.kind, c.name);
      if (ids.has(key)) continue;
      const category = await repos.categories.create({
        name: c.name,
        kind: c.kind,
        color: '#64748b',
        icon: 'tag',
      });
      created.push(category.id);
      ids.set(key, category.id);
    }
    return await repos.transactions.bulkInsert(
      plan.rows.map((r) => {
        const categoryId = ids.get(r.categoryKey);
        if (!categoryId) throw new Error('Category missing for import row');
        return { ...r.input, categoryId };
      }),
    );
  } catch (err) {
    for (const id of created) await repos.categories.softDelete(id).catch(() => undefined);
    throw err;
  }
}
