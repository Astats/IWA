import fc from 'fast-check';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';

import type { Transaction } from '../domain';
import { aTransaction, createInMemoryRepositories, testFaker } from '../testing';

import { exportErrorsCsv, exportTransactionsCsv } from './export';
import { escapeCell, quoteField, unescapeCell } from './format';
import { commitImport, loadImportContext, parseCsvText, planImport, validateRows } from './import';

testFaker.seed(12345);

const CAT = { id: '0192f0c1-7a3b-7c3d-8e4f-1a2b3c4d5e6f', name: 'Food' };
const categories = new Map([[CAT.id, { name: CAT.name }]]);

/** Parses exported CSV back into raw cells (what a spreadsheet would read). */
function cells(csv: string): string[][] {
  return Papa.parse<string[]>(csv.replace(/^\ufeff/, ''), { skipEmptyLines: true }).data;
}

describe('escapeCell (formula injection, SEC-W10)', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\t=1', '\r=1', ' =cmd|calc', '  @x', "'quoted"])(
    'prefixes %j with an apostrophe',
    (value) => {
      expect(escapeCell(value)).toBe(`'${value}`);
    },
  );

  it.each(['plain', '1-2', 'a=b', 'émoji 😀', ''])('leaves %j unchanged', (value) => {
    expect(escapeCell(value)).toBe(value);
  });

  it('unescape restores every value exactly', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(unescapeCell(escapeCell(value))).toBe(value);
      }),
    );
  });
});

describe('quoteField (RFC 4180)', () => {
  it.each([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['line1\nline2', '"line1\nline2"'],
    ['cr\r\nlf', '"cr\r\nlf"'],
  ])('%j → %j', (input, expected) => {
    expect(quoteField(input)).toBe(expected);
  });
});

describe('exportTransactionsCsv', () => {
  const tx = (overrides: Partial<Transaction>) =>
    aTransaction({ id: '0192f0c1-7a3b-7c3d-8e4f-000000000001', categoryId: CAT.id, ...overrides });

  it('writes a BOM, the v1 header, CRLF line ends and plain positive amounts', () => {
    const csv = exportTransactionsCsv(
      [
        tx({
          date: '2026-03-01',
          kind: 'expense',
          amountMinor: 123456,
          currency: 'EUR',
          note: 'Lunch',
        }),
      ],
      categories,
    );

    expect(csv).toBe(
      '\ufeffdate,kind,amount,currency,category,note,id\r\n' +
        '2026-03-01,expense,1234.56,EUR,Food,Lunch,0192f0c1-7a3b-7c3d-8e4f-000000000001\r\n',
    );
  });

  it.each([
    ['JPY', 1500, '1500'],
    ['KWD', 1, '0.001'],
    ['EUR', 10 ** 13, '100000000000.00'],
  ])('formats %s amounts exactly', (currency, minor, expected) => {
    const [, row] = cells(
      exportTransactionsCsv([tx({ currency, amountMinor: minor })], categories),
    );

    expect(row?.[2]).toBe(expected);
  });

  it('escapes dangerous notes and category names so a spreadsheet reads them as text', () => {
    const notes = ['=HYPERLINK("http://x")', '+1', '-1', '@x', '\tx', ' =1'];
    const csv = exportTransactionsCsv(
      notes.map((note, i) => tx({ id: `0192f0c1-7a3b-7c3d-8e4f-00000000000${i + 1}`, note })),
      new Map([[CAT.id, { name: '=cmd' }]]),
    );

    for (const [i, row] of cells(csv).slice(1).entries()) {
      expect(row[5]).toBe(`'${notes[i] ?? ''}`);
      expect(row[4]).toBe("'=cmd");
    }
  });

  it('quotes commas, quotes and newlines and keeps Unicode intact', () => {
    const note = 'ā č ē ģ ī ķ ļ ņ š ū ž, 中文 "quoted"\nsecond line 😀';
    const [, row] = cells(exportTransactionsCsv([tx({ note })], categories));

    expect(row?.[5]).toBe(note);
  });

  it('exports an empty list as just the header', () => {
    expect(exportTransactionsCsv([], categories)).toBe(
      '\ufeffdate,kind,amount,currency,category,note,id\r\n',
    );
  });

  it('error CSV lists row, field and message', () => {
    expect(exportErrorsCsv([{ row: 3, field: 'amount', message: '=bad, value' }])).toBe(
      '\ufeffrow,field,message\r\n3,amount,"\'=bad, value"\r\n',
    );
  });
});

describe('round-trip: import(export(list)) deep-equals list', () => {
  const noteArb = fc
    .string({ maxLength: 60 })
    .map((s) => s.trim())
    .filter((s) => !s.includes('\u0000'));

  it('for any valid list of transactions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom('income' as const, 'expense' as const),
            amountMinor: fc.integer({ min: 1, max: 10 ** 13 }),
            currency: fc.constantFrom('EUR', 'JPY', 'KWD', 'USD'),
            date: fc
              .date({
                min: new Date('2000-01-01'),
                max: new Date('2099-12-31'),
                noInvalidDate: true,
              })
              .map((d) => d.toISOString().slice(0, 10)),
            note: noteArb,
          }),
          { minLength: 1, maxLength: 25 },
        ),
        async (items) => {
          const source = createInMemoryRepositories();
          await source.categories.seedDefaults();
          const cats = await source.categories.list();
          const pick = (kind: string) => cats.find((c) => c.kind === kind)!;
          for (const item of items) {
            await source.transactions.create({ ...item, categoryId: pick(item.kind).id });
          }
          const original = [];
          for await (const t of source.transactions.exportAll()) original.push(t);

          const csv = exportTransactionsCsv(original, new Map(cats.map((c) => [c.id, c])));
          const target = createInMemoryRepositories();
          await target.categories.seedDefaults();
          const { valid, errors } = validateRows(parseCsvText(csv));
          const plan = planImport(valid, await loadImportContext(target), {
            skipDuplicates: true,
            createCategories: true,
          });
          await commitImport(target, plan);

          expect(errors).toEqual([]);
          const imported = [];
          for await (const t of target.transactions.exportAll()) imported.push(t);
          const comparable = (t: Transaction, names: Map<string, string>) => ({
            id: t.id,
            date: t.date,
            kind: t.kind,
            amountMinor: t.amountMinor,
            currency: t.currency,
            note: t.note,
            category: names.get(t.categoryId),
          });
          const sourceNames = new Map(cats.map((c) => [c.id, c.name]));
          const targetNames = new Map((await target.categories.list()).map((c) => [c.id, c.name]));
          const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
          expect(imported.map((t) => comparable(t, targetNames)).sort(byId)).toEqual(
            original.map((t) => comparable(t, sourceNames)).sort(byId),
          );
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('exportTransactionsCsv edge cases', () => {
  it('writes an empty category for an unknown category id', () => {
    const [, row] = cells(
      exportTransactionsCsv(
        [aTransaction({ categoryId: '0192f0c1-7a3b-7c3d-8e4f-0000000000ff' })],
        new Map(),
      ),
    );

    expect(row?.[4]).toBe('');
  });
});
