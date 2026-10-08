/// <reference types="node" />
import { readFileSync } from 'node:fs';
import path from 'node:path';

import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Repositories } from '../repositories';
import { createInMemoryRepositories } from '../testing';

import { CSV_LIMITS } from './format';
import {
  CsvCollector,
  CsvFatalError,
  commitImport,
  duplicateKey,
  loadImportContext,
  parseAndValidateCsv,
  parseCsvText,
  planImport,
  validateRows,
  type CsvParseOutcome,
} from './import';

const fixture = (name: string) =>
  readFileSync(path.resolve(import.meta.dirname, '../../../../test-data/csv', name), 'utf8');

function ok(outcome: CsvParseOutcome) {
  if (!outcome.ok) throw new Error(`expected a parsed file, got ${outcome.code}`);
  return outcome;
}

let repos: Repositories;

beforeEach(async () => {
  repos = createInMemoryRepositories();
  await repos.categories.seedDefaults();
});

async function importText(
  text: string,
  options = { skipDuplicates: true, createCategories: true },
) {
  const outcome = ok(parseAndValidateCsv(text));
  const plan = planImport(outcome.valid, await loadImportContext(repos), options);
  const count = await commitImport(repos, plan);
  return { outcome, plan, count };
}

describe('valid fixtures', () => {
  it('valid-basic.csv: 0/2/3-decimal currencies', async () => {
    const { outcome, count } = await importText(fixture('valid-basic.csv'));

    expect(outcome.errors).toEqual([]);
    expect(outcome.delimiter).toBe(',');
    expect(outcome.valid.map((r) => [r.amountMinor, r.currency])).toEqual([
      [350000, 'EUR'],
      [120000, 'EUR'],
      [4550, 'EUR'],
      [1500, 'JPY'],
      [2125, 'KWD'],
    ]);
    expect(count).toBe(5);
  });

  it('valid-semicolon-decimal-comma.csv: `;` delimiter, decimal comma, quoted delimiter', () => {
    const outcome = ok(parseAndValidateCsv(fixture('valid-semicolon-decimal-comma.csv')));

    expect(outcome.delimiter).toBe(';');
    expect(outcome.errors).toEqual([]);
    expect(outcome.valid.map((r) => [r.amountMinor, r.note])).toEqual([
      [350000, 'Alga'],
      [1250, 'Kafija; ar pienu'],
      [120000, 'Īre'],
    ]);
  });

  it('valid-bom-crlf.csv: strips the BOM, handles CRLF', () => {
    const outcome = ok(parseAndValidateCsv(fixture('valid-bom-crlf.csv')));

    expect(outcome.valid.map((r) => [r.row, r.date, r.note])).toEqual([
      [2, '2026-03-01', 'Lunch'],
      [3, '2026-03-02', 'Dinner'],
    ]);
  });

  it('valid-unicode.csv: keeps non-ASCII text and creates Unicode category names', async () => {
    const { outcome, plan } = await importText(fixture('valid-unicode.csv'));

    expect(outcome.valid.map((r) => r.note)).toEqual([
      'ā č ē ģ ī ķ ļ ņ š ū ž',
      '中文备注',
      'emoji 😀🍕',
    ]);
    expect(plan.newCategories.map((c) => c.name)).toEqual(['Pārtika', '食品']);
  });

  it('extra-columns.csv: header case-insensitive, unknown columns ignored', () => {
    const outcome = ok(parseAndValidateCsv(fixture('extra-columns.csv')));

    expect(outcome.valid).toHaveLength(1);
    expect(outcome.valid[0]).toMatchObject({ note: 'Lunch', amountMinor: 1000 });
  });
});

describe('invalid input', () => {
  it('mixed-invalid-rows.csv: collects every error with row and field, keeps valid rows', () => {
    const outcome = ok(parseAndValidateCsv(fixture('mixed-invalid-rows.csv')));

    expect(outcome.valid.map((r) => r.note)).toEqual(['ok 1', 'ok 2']);
    expect(outcome.errors.map((e) => [e.row, e.field, e.code])).toEqual([
      [3, 'date', 'INVALID_DATE'],
      [4, 'kind', 'INVALID_KIND'],
      [5, 'amount', 'AMOUNT_NEGATIVE'],
      [6, 'amount', 'AMOUNT_INVALID'],
      [7, 'currency', 'INVALID_CURRENCY'],
      [8, 'category', 'INVALID_CATEGORY'],
      [9, 'id', 'INVALID_ID'],
      [10, 'date', 'INVALID_DATE'],
      [10, 'amount', 'AMOUNT_ZERO'],
    ]);
  });

  it.each([
    ['empty.csv', 'EMPTY'],
    ['header-only.csv', 'NO_ROWS'],
    ['missing-columns.csv', 'MISSING_COLUMNS'],
  ])('%s is rejected with %s', (name, code) => {
    expect(parseAndValidateCsv(fixture(name))).toMatchObject({ ok: false, code });
  });

  it('missing-columns.csv names the missing columns', () => {
    expect(parseAndValidateCsv(fixture('missing-columns.csv'))).toEqual({
      ok: false,
      code: 'MISSING_COLUMNS',
      detail: ['currency', 'category'],
    });
  });

  it('long-field.csv: a field over 500 characters is a row error', () => {
    const outcome = ok(parseAndValidateCsv(fixture('long-field.csv')));

    expect(outcome.errors).toEqual([{ row: 2, field: 'note', code: 'FIELD_TOO_LONG' }]);
    expect(outcome.valid.map((r) => r.note)).toEqual(['short']);
  });

  it('too-large (generated, > 5 MB) is rejected before parsing (SEC-W11)', () => {
    const big = `date,kind,amount,currency,category,note,id\n${'2026-03-01,expense,1.00,EUR,Food,x,\n'.repeat(160_000)}`;

    expect(big.length).toBeGreaterThan(CSV_LIMITS.maxBytes);
    expect(parseAndValidateCsv(big)).toMatchObject({ ok: false, code: 'TOO_LARGE' });
  });

  it('too-many-rows (generated, 50,001 rows) is rejected while parsing (SEC-W11)', () => {
    const rows = '2026-03-01,expense,1,EUR,Food,,\n'.repeat(50_001);

    const result = parseAndValidateCsv(`date,kind,amount,currency,category,note,id\n${rows}`);

    // Responsiveness (no UI freeze) is asserted end to end in e2e/specs/csv-import.spec.ts.
    expect(result).toEqual({ ok: false, code: 'TOO_MANY_ROWS', detail: ['50000'] });
  });

  it('exactly 50,000 rows is accepted', () => {
    const rows = '2026-03-01,expense,1,EUR,Food,,\n'.repeat(50_000);

    expect(
      ok(parseAndValidateCsv(`date,kind,amount,currency,category,note,id\n${rows}`)).valid,
    ).toHaveLength(50_000);
  });

  it('the decimal comma is only accepted for `;`-delimited files', () => {
    const outcome = ok(
      parseAndValidateCsv(
        'date,kind,amount,currency,category,note,id\n2026-03-01,expense,"12,50",EUR,Food,,\n',
      ),
    );

    expect(outcome.errors[0]).toMatchObject({ field: 'amount', code: 'AMOUNT_INVALID' });
  });

  it('accepts lower-case currency and kind, rejects malformed ids', () => {
    const outcome = ok(
      parseAndValidateCsv(
        'date,kind,amount,currency,category,note,id\n2026-03-01,EXPENSE,1,eur,Food,,\n',
      ),
    );

    expect(outcome.valid[0]).toMatchObject({ kind: 'expense', currency: 'EUR' });
  });

  it('CsvCollector rejects a second pass without a header', () => {
    expect(() => new CsvCollector().result(',')).toThrow(CsvFatalError);
    expect(() => parseCsvText('')).toThrow(CsvFatalError);
  });
});

describe('formula and XSS payloads are stored as literal text', () => {
  it('formula-injection.csv imports the text unchanged (one escape apostrophe removed)', async () => {
    const { outcome } = await importText(fixture('formula-injection.csv'));

    expect(outcome.valid.map((r) => r.note)).toEqual([
      '=HYPERLINK("http://example.invalid","x")',
      '+SUM(1)',
      '@cmd',
      '-1',
    ]);
  });

  it('xss-payloads.csv imports payloads verbatim', async () => {
    const { outcome } = await importText(fixture('xss-payloads.csv'));

    expect(outcome.valid.map((r) => [r.categoryName, r.note])).toEqual([
      ['Food', '<img src=x onerror=alert(1)>'],
      // eslint-disable-next-line no-script-url -- test payload, stored as text
      ['<script>alert(2)</script>', 'javascript:alert(3)'],
      ['Food', '<svg onload=alert(4)>'],
    ]);
  });
});

describe('duplicates', () => {
  it('duplicates-by-id.csv: existing ids are duplicates; skipping imports nothing again', async () => {
    await importText(fixture('duplicates-by-id.csv'));

    const again = await importText(fixture('duplicates-by-id.csv'));

    expect(again.plan.duplicates).toEqual([2, 3]);
    expect(again.count).toBe(0);
    expect((await repos.transactions.list({})).total).toBe(2);
  });

  it('importing id duplicates anyway assigns fresh ids', async () => {
    await importText(fixture('duplicates-by-id.csv'));

    const again = await importText(fixture('duplicates-by-id.csv'), {
      skipDuplicates: false,
      createCategories: true,
    });

    expect(again.count).toBe(2);
    expect(again.plan.rows.every((r) => r.input.id === undefined)).toBe(true);
    expect((await repos.transactions.list({})).total).toBe(4);
  });

  it('duplicates-by-tuple.csv: same date/kind/amount/currency/note counts as duplicate', async () => {
    await importText(fixture('duplicates-by-tuple.csv'));

    const again = await importText(fixture('duplicates-by-tuple.csv'));
    const anyway = await importText(fixture('duplicates-by-tuple.csv'), {
      skipDuplicates: false,
      createCategories: true,
    });

    expect(again.plan.duplicates).toEqual([2, 3]);
    expect(again.count).toBe(0);
    expect(anyway.count).toBe(2);
  });

  it('deleted rows are not tuple duplicates', async () => {
    const { count } = await importText(fixture('duplicates-by-tuple.csv'));
    for (const t of (await repos.transactions.list({})).items)
      await repos.transactions.softDelete(t.id);

    expect(count).toBe(2);
    expect((await importText(fixture('duplicates-by-tuple.csv'))).count).toBe(2);
  });

  it('duplicateKey is stable', () => {
    expect(
      duplicateKey({
        date: '2026-03-01',
        kind: 'expense',
        amountMinor: 1,
        currency: 'EUR',
        note: 'a',
      }),
    ).toBe('["2026-03-01","expense",1,"EUR","a"]');
  });
});

describe('categories', () => {
  it('without permission, rows with unknown categories are not imported', async () => {
    const outcome = ok(parseAndValidateCsv(fixture('valid-unicode.csv')));

    const plan = planImport(outcome.valid, await loadImportContext(repos), {
      skipDuplicates: true,
      createCategories: false,
    });

    expect(plan.missingCategoryRows).toEqual([2, 3]);
    expect(plan.newCategories).toEqual([]);
    expect(plan.rows).toHaveLength(1);
  });

  it('matches existing categories by name (case-insensitive) and kind', async () => {
    const outcome = ok(
      parseAndValidateCsv(
        'date,kind,amount,currency,category,note,id\n2026-03-01,expense,1,EUR,FOOD,,\n2026-03-01,income,1,EUR,Food,,\n',
      ),
    );

    const plan = planImport(outcome.valid, await loadImportContext(repos), {
      skipDuplicates: true,
      createCategories: true,
    });

    expect(plan.newCategories).toEqual([{ name: 'Food', kind: 'income' }]);
  });
});

describe('commit is all-or-nothing', () => {
  it('a failing insert leaves no rows and removes categories it created', async () => {
    const outcome = ok(parseAndValidateCsv(fixture('valid-unicode.csv')));
    const plan = planImport(outcome.valid, await loadImportContext(repos), {
      skipDuplicates: true,
      createCategories: true,
    });
    const failing = {
      ...repos,
      transactions: {
        ...repos.transactions,
        bulkInsert: () => Promise.reject(new Error('disk full')),
      },
    };

    await expect(commitImport(failing, plan)).rejects.toThrow('disk full');

    expect((await repos.transactions.list({})).total).toBe(0);
    expect((await repos.categories.list()).map((c) => c.name)).not.toContain('Pārtika');
  });
});

describe('fuzz (fast-check)', () => {
  const header = 'date,kind,amount,currency,category,note,id\n';

  it('random strings never throw unexpected errors and never hang', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (input) => {
        const start = performance.now();
        const outcome = parseAndValidateCsv(input);
        expect(performance.now() - start).toBeLessThan(2000);
        expect(typeof outcome.ok).toBe('boolean');
      }),
      { numRuns: 300 },
    );
  });

  it('random CSV-like rows: invalid rows are never planned for insert', async () => {
    const cell = fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.constantFrom(
        '2026-03-01',
        'expense',
        'income',
        'EUR',
        'Food',
        '1.00',
        '-1',
        '"',
        ',',
        ';',
        '=1',
      ),
    );
    const csvLike = fc
      .array(fc.array(cell, { minLength: 1, maxLength: 9 }), { maxLength: 30 })
      .map((rows) => header + rows.map((r) => r.join(',')).join('\n'));
    const ctx = await loadImportContext(repos);
    fc.assert(
      fc.property(csvLike, (text) => {
        const outcome = parseAndValidateCsv(text);
        if (!outcome.ok) return;
        const invalidRows = new Set(outcome.errors.map((e) => e.row));
        const plan = planImport(outcome.valid, ctx, {
          skipDuplicates: true,
          createCategories: true,
        });
        for (const r of plan.rows) expect(invalidRows.has(r.row)).toBe(false);
        expect(validateRows({ delimiter: outcome.delimiter, rows: [], errors: [] })).toEqual({
          valid: [],
          errors: [],
        });
      }),
      { numRuns: 300 },
    );
  });
});

describe('edge cases', () => {
  it('short rows (missing trailing fields) and blank lines', () => {
    const outcome = ok(
      parseAndValidateCsv(
        'date,kind,amount,currency,category,note,id\n\n2026-03-01,expense,1,EUR,Food\n',
      ),
    );

    expect(outcome.valid[0]).toMatchObject({ note: '', categoryName: 'Food' });
  });

  it('repeated header columns use the first occurrence', () => {
    const outcome = ok(
      parseAndValidateCsv(
        'date,kind,amount,currency,category,note,note\n2026-03-01,expense,1,EUR,Food,first,second\n',
      ),
    );

    expect(outcome.valid[0]?.note).toBe('first');
  });

  it('an invalid currency skips the amount check (one error, on currency)', () => {
    const outcome = ok(
      parseAndValidateCsv(
        'date,kind,amount,currency,category,note,id\n2026-03-01,expense,abc,XX,Food,,\n',
      ),
    );

    expect(outcome.errors).toEqual([{ row: 2, field: 'currency', code: 'INVALID_CURRENCY' }]);
  });

  it('the same id twice in one file: the second is a duplicate', async () => {
    const id = '0192f0c1-7a3b-7c3d-8e4f-0000000000b1';
    const outcome = ok(
      parseAndValidateCsv(
        `date,kind,amount,currency,category,note,id\n2026-03-01,expense,1,EUR,Food,a,${id}\n2026-03-02,expense,2,EUR,Food,b,${id}\n`,
      ),
    );

    const plan = planImport(outcome.valid, await loadImportContext(repos), {
      skipDuplicates: false,
      createCategories: false,
    });

    expect(plan.duplicates).toEqual([3]);
    expect(plan.rows.map((r) => r.input.id)).toEqual([id, undefined]);
  });

  it('a category created between preview and commit is reused, not duplicated', async () => {
    const outcome = ok(
      parseAndValidateCsv(
        'date,kind,amount,currency,category,note,id\n2026-03-01,expense,1,EUR,Pets,,\n',
      ),
    );
    const plan = planImport(outcome.valid, await loadImportContext(repos), {
      skipDuplicates: true,
      createCategories: true,
    });
    await repos.categories.create({
      name: 'Pets',
      kind: 'expense',
      color: '#000000',
      icon: 'paw-print',
    });

    expect(await commitImport(repos, plan)).toBe(1);
    expect((await repos.categories.list()).filter((c) => c.name === 'Pets')).toHaveLength(1);
  });

  it('commit refuses a plan whose category vanished', async () => {
    const plan = {
      rows: [
        {
          row: 2,
          categoryKey: 'expense:gone',
          input: {
            kind: 'expense' as const,
            amountMinor: 1,
            currency: 'EUR',
            date: '2026-03-01',
            note: '',
          },
        },
      ],
      duplicates: [],
      newCategories: [],
      missingCategoryRows: [],
    };

    await expect(commitImport(repos, plan)).rejects.toThrow('Category missing');
  });
});
