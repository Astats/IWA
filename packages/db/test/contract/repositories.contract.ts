import {
  isDomainError,
  type Category,
  type DomainErrorCode,
  type NewTransaction,
  type Repositories,
  type SortKey,
  type Transaction,
} from '@budget/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Factory for a fresh, empty, migrated set of repositories (plus optional cleanup). */
export type MakeRepos = () => Promise<{ repos: Repositories; close?: () => Promise<void> }>;

async function expectDomainError(promise: Promise<unknown>, code: DomainErrorCode): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(isDomainError(err, code), `expected DomainError ${code}, got ${String(err)}`).toBe(true);
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/**
 * Repository contract suite (TEST_PLAN §4.3). Every backend — sqlite-wasm in Node, the worker
 * driver in a browser, the in-memory fakes, later native and Postgres — must pass it unchanged.
 */
export function runRepositoryContract(name: string, makeRepos: MakeRepos): void {
  describe(`repository contract: ${name}`, () => {
    let repos: Repositories;
    let close: (() => Promise<void>) | undefined;
    let food: Category;
    let rent: Category;
    let salary: Category;

    beforeEach(async () => {
      ({ repos, close } = await makeRepos());
      food = await repos.categories.create({
        name: 'Food',
        kind: 'expense',
        color: '#ff0000',
        icon: 'utensils',
      });
      rent = await repos.categories.create({
        name: 'Rent',
        kind: 'expense',
        color: '#00ff00',
        icon: 'home',
      });
      salary = await repos.categories.create({
        name: 'Salary',
        kind: 'income',
        color: '#0000ff',
        icon: 'briefcase',
      });
    });

    afterEach(async () => {
      await close?.();
    });

    const expense = (overrides: Partial<NewTransaction> = {}): NewTransaction => ({
      kind: 'expense',
      amountMinor: 1000,
      currency: 'EUR',
      categoryId: food.id,
      date: '2026-03-10',
      note: '',
      ...overrides,
    });

    describe('transactions CRUD', () => {
      it('creates, reads and updates a transaction', async () => {
        const created = await repos.transactions.create(expense({ note: '  Lunch  ' }));

        expect(created).toMatchObject({
          kind: 'expense',
          amountMinor: 1000,
          note: 'Lunch',
          deletedAt: null,
        });
        expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(created.createdAt).toBe(created.updatedAt);
        expect(await repos.transactions.get(created.id)).toEqual(created);

        const updated = await repos.transactions.update(created.id, {
          amountMinor: 2500,
          categoryId: rent.id,
        });

        expect(updated).toMatchObject({ amountMinor: 2500, categoryId: rent.id, note: 'Lunch' });
        expect(updated.updatedAt > created.updatedAt).toBe(true);
        expect(await repos.transactions.get(created.id)).toEqual(updated);
      });

      it('keeps the note when a patch omits it', async () => {
        const t = await repos.transactions.create(expense({ note: 'keep me' }));

        const updated = await repos.transactions.update(t.id, { date: '2026-03-11' });

        expect(updated.note).toBe('keep me');
      });

      it('get returns null for unknown ids', async () => {
        expect(await repos.transactions.get('0192f0c1-7a3b-7c3d-8e4f-000000000000')).toBeNull();
      });

      it('rejects a category of the other kind', async () => {
        await expectDomainError(
          repos.transactions.create(expense({ categoryId: salary.id })),
          'CATEGORY_KIND_MISMATCH',
        );
        const t = await repos.transactions.create(expense());
        await expectDomainError(
          repos.transactions.update(t.id, { kind: 'income' }),
          'CATEGORY_KIND_MISMATCH',
        );
        await expectDomainError(
          repos.transactions.update(t.id, { categoryId: salary.id }),
          'CATEGORY_KIND_MISMATCH',
        );
      });

      it('rejects unknown and deleted categories', async () => {
        await expectDomainError(
          repos.transactions.create(
            expense({ categoryId: '0192f0c1-7a3b-7c3d-8e4f-000000000000' }),
          ),
          'CATEGORY_NOT_FOUND',
        );
        const empty = await repos.categories.create({
          name: 'Old',
          kind: 'expense',
          color: '#123456',
          icon: 'tag',
        });
        await repos.categories.softDelete(empty.id);
        await expectDomainError(
          repos.transactions.create(expense({ categoryId: empty.id })),
          'CATEGORY_NOT_FOUND',
        );
      });

      it('rejects invalid input without writing', async () => {
        await expect(repos.transactions.create(expense({ amountMinor: 0 }))).rejects.toThrow();
        await expect(repos.transactions.create(expense({ date: '2026-02-30' }))).rejects.toThrow();
        await expect(repos.transactions.create(expense({ currency: 'eur' }))).rejects.toThrow();

        expect((await repos.transactions.list({})).total).toBe(0);
      });

      it('accepts a client id once and rejects duplicates', async () => {
        const id = '0192f0c1-7a3b-7c3d-8e4f-1a2b3c4d5e6f';

        expect((await repos.transactions.create(expense({ id }))).id).toBe(id);
        await expectDomainError(repos.transactions.create(expense({ id })), 'DUPLICATE_ID');
      });

      it('update of an unknown or deleted row → NOT_FOUND', async () => {
        const t = await repos.transactions.create(expense());
        await repos.transactions.softDelete(t.id);

        await expectDomainError(repos.transactions.update(t.id, { amountMinor: 5 }), 'NOT_FOUND');
        await expectDomainError(
          repos.transactions.update('0192f0c1-7a3b-7c3d-8e4f-000000000000', { amountMinor: 5 }),
          'NOT_FOUND',
        );
      });
    });

    describe('soft delete and restore', () => {
      it('hides deleted rows everywhere and restores them', async () => {
        const t = await repos.transactions.create(expense({ amountMinor: 700 }));
        const range = { dateFrom: '2026-03-01', dateTo: '2026-03-31' };

        await repos.transactions.softDelete(t.id);

        expect(await repos.transactions.get(t.id)).toBeNull();
        expect((await repos.transactions.list({})).total).toBe(0);
        expect((await repos.transactions.totals(range)).byCurrency).toEqual([]);
        expect(await repos.transactions.byCategory({ ...range, kind: 'expense' })).toEqual([]);
        expect(await collect(repos.transactions.exportAll())).toEqual([]);
        expect(await collect(repos.transactions.exportAll({ includeDeleted: true }))).toHaveLength(
          1,
        );

        await repos.transactions.restore(t.id);

        expect(await repos.transactions.get(t.id)).toMatchObject({
          id: t.id,
          deletedAt: null,
          amountMinor: 700,
        });
        expect((await repos.transactions.list({})).total).toBe(1);
      });

      it('double delete / restore of an active row → NOT_FOUND', async () => {
        const t = await repos.transactions.create(expense());

        await expectDomainError(repos.transactions.restore(t.id), 'NOT_FOUND');
        await repos.transactions.softDelete(t.id);
        await expectDomainError(repos.transactions.softDelete(t.id), 'NOT_FOUND');
      });

      it('updated_at strictly increases across create → update → delete → restore', async () => {
        const t = await repos.transactions.create(expense());
        const stamps = [t.updatedAt];
        stamps.push((await repos.transactions.update(t.id, { note: 'a' })).updatedAt);
        await repos.transactions.softDelete(t.id);
        stamps.push(
          (await collect(repos.transactions.exportAll({ includeDeleted: true })))[0]!.updatedAt,
        );
        await repos.transactions.restore(t.id);
        stamps.push((await repos.transactions.get(t.id))!.updatedAt);

        for (let i = 1; i < stamps.length; i++) expect(stamps[i]! > stamps[i - 1]!).toBe(true);
      });
    });

    describe('list: sorting, filtering, pagination', () => {
      let rows: Transaction[];

      beforeEach(async () => {
        const inputs: NewTransaction[] = [
          expense({
            amountMinor: 500,
            date: '2026-01-15',
            note: 'Groceries at market',
            categoryId: food.id,
          }),
          expense({
            amountMinor: 120000,
            date: '2026-02-01',
            note: 'February rent',
            categoryId: rent.id,
          }),
          expense({
            amountMinor: 1500,
            date: '2026-02-14',
            note: 'Dinner 🍝 date',
            categoryId: food.id,
          }),
          {
            kind: 'income',
            amountMinor: 300000,
            currency: 'EUR',
            categoryId: salary.id,
            date: '2026-02-28',
            note: 'Salary Feb',
          },
          expense({
            amountMinor: 1500,
            date: '2026-03-03',
            note: 'Coffee beans',
            categoryId: food.id,
            currency: 'USD',
          }),
          {
            kind: 'income',
            amountMinor: 310000,
            currency: 'EUR',
            categoryId: salary.id,
            date: '2026-03-31',
            note: 'salary march',
          },
          expense({
            amountMinor: 120000,
            date: '2026-03-01',
            note: 'March rent',
            categoryId: rent.id,
          }),
        ];
        rows = [];
        for (const input of inputs) rows.push(await repos.transactions.create(input));
      });

      const categoryName = (t: Transaction) =>
        ({ [food.id]: 'food', [rent.id]: 'rent', [salary.id]: 'salary' })[t.categoryId] ?? '';
      const sortValue: Record<SortKey, (t: Transaction) => string | number> = {
        date: (t) => t.date,
        amount: (t) => t.amountMinor,
        category: categoryName,
        kind: (t) => t.kind,
      };

      for (const sortBy of ['date', 'amount', 'category', 'kind'] as const) {
        for (const sortDir of ['asc', 'desc'] as const) {
          it(`sorts by ${sortBy} ${sortDir} (ties broken by id)`, async () => {
            const sign = sortDir === 'asc' ? 1 : -1;
            const key = sortValue[sortBy];
            const expected = [...rows]
              .sort((a, b) => {
                const ka = key(a);
                const kb = key(b);
                const primary = ka < kb ? -1 : ka > kb ? 1 : 0;
                return sign * (primary || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
              })
              .map((t) => t.id);

            const { items } = await repos.transactions.list({ sortBy, sortDir });

            expect(items.map((t) => t.id)).toEqual(expected);
          });
        }
      }

      it('defaults to date descending', async () => {
        const { items } = await repos.transactions.list({});

        expect(items.map((t) => t.date)).toEqual([...rows.map((t) => t.date)].sort().reverse());
      });

      it.each([
        [{ kind: 'income' as const }, 2],
        [{ kind: 'expense' as const }, 5],
        [{ dateFrom: '2026-02-01' }, 6],
        [{ dateTo: '2026-02-14' }, 3],
        [{ dateFrom: '2026-02-01', dateTo: '2026-02-28' }, 3],
        [{ search: 'RENT' }, 2],
        [{ search: 'salary' }, 2],
        [{ search: '🍝' }, 1],
        [{ search: 'nothing matches' }, 0],
        [{ kind: 'expense' as const, dateFrom: '2026-02-01', search: 'rent' }, 2],
        [{ kind: 'income' as const, dateTo: '2026-03-01' }, 1],
      ])('filters %j → %i rows', async (filter, count) => {
        const { items, total } = await repos.transactions.list(filter);

        expect(total).toBe(count);
        expect(items).toHaveLength(count);
      });

      it('filters by category ids (alone and combined)', async () => {
        expect((await repos.transactions.list({ categoryIds: [food.id] })).total).toBe(3);
        expect((await repos.transactions.list({ categoryIds: [food.id, rent.id] })).total).toBe(5);
        expect(
          (await repos.transactions.list({ categoryIds: [food.id], dateFrom: '2026-02-01' })).total,
        ).toBe(2);
        expect((await repos.transactions.list({ categoryIds: [] })).total).toBe(7);
      });

      it('paginates, including an offset beyond the total', async () => {
        const page1 = await repos.transactions.list({
          limit: 3,
          offset: 0,
          sortBy: 'date',
          sortDir: 'asc',
        });
        const page3 = await repos.transactions.list({
          limit: 3,
          offset: 6,
          sortBy: 'date',
          sortDir: 'asc',
        });
        const beyond = await repos.transactions.list({ limit: 3, offset: 100 });

        expect(page1.items).toHaveLength(3);
        expect(page1.total).toBe(7);
        expect(page3.items).toHaveLength(1);
        expect(beyond).toEqual({ items: [], total: 7 });
        expect((await repos.transactions.list({ limit: 500 })).items).toHaveLength(7);
        await expect(repos.transactions.list({ limit: 501 })).rejects.toThrow();
      });

      it('rejects a sort key outside the allow-list', async () => {
        await expect(
          repos.transactions.list({
            sortBy: 'note; DROP TABLE transactions' as unknown as SortKey,
          }),
        ).rejects.toThrow();
        expect((await repos.transactions.list({})).total).toBe(7);
      });
    });

    describe('search is literal (SQL injection)', () => {
      const notes = [
        '100% organic',
        'under_score',
        "O'Reilly book",
        '"; DROP TABLE transactions; --',
        "%' OR 1=1 --",
        'zīmulis ķirbis 🎃',
        'plain text',
      ];

      beforeEach(async () => {
        for (const note of notes) await repos.transactions.create(expense({ note }));
      });

      it.each([
        ['%', 2],
        ['_', 1],
        ["'", 2],
        ['"; DROP TABLE transactions; --', 1],
        ["%' OR 1=1 --", 1],
        ['ķirbis 🎃', 1],
        ['🎃', 1],
        ['\\', 0],
      ])('search %j matches %i row(s) literally', async (search, count) => {
        const { items, total } = await repos.transactions.list({ search });

        expect(total).toBe(count);
        for (const t of items) expect(t.note.toLowerCase()).toContain(search.toLowerCase());
        expect((await repos.transactions.list({})).total).toBe(notes.length);
      });
    });

    describe('totals and byCategory', () => {
      it('match independently computed BigInt sums per currency and kind', async () => {
        const inputs: NewTransaction[] = [];
        let seed = 7;
        const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
        for (let i = 0; i < 60; i++) {
          const income = next() % 3 === 0;
          inputs.push({
            kind: income ? 'income' : 'expense',
            categoryId: income ? salary.id : next() % 2 ? food.id : rent.id,
            amountMinor: (next() % 1_000_000) + 1,
            currency: next() % 4 === 0 ? 'USD' : 'EUR',
            date: `2026-0${(next() % 3) + 1}-1${next() % 9}`,
            note: '',
          });
        }
        inputs.push(
          expense({ amountMinor: 10 ** 13, date: '2026-02-10' }),
          expense({ amountMinor: 10 ** 13, date: '2026-02-11' }),
        );
        await repos.transactions.bulkInsert(inputs);
        const range = { dateFrom: '2026-02-01', dateTo: '2026-03-31' };
        const inRange = inputs.filter((t) => t.date >= range.dateFrom && t.date <= range.dateTo);

        const totals = await repos.transactions.totals(range);
        const byCat = await repos.transactions.byCategory({ ...range, kind: 'expense' });

        const expected = new Map<string, { income: bigint; expense: bigint }>();
        for (const t of inRange) {
          const e = expected.get(t.currency) ?? { income: 0n, expense: 0n };
          e[t.kind] += BigInt(t.amountMinor);
          expected.set(t.currency, e);
        }
        expect(totals.byCurrency).toEqual(
          [...expected.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([currency, e]) => ({ currency, ...e, balance: e.income - e.expense })),
        );
        for (const row of byCat) {
          const matching = inRange.filter(
            (t) =>
              t.kind === 'expense' &&
              t.categoryId === row.categoryId &&
              t.currency === row.currency,
          );
          expect(row.total).toBe(matching.reduce((s, t) => s + BigInt(t.amountMinor), 0n));
          expect(row.count).toBe(matching.length);
          expect(row.categoryName).toBe(row.categoryId === food.id ? 'Food' : 'Rent');
        }
        expect(byCat.reduce((s, r) => s + r.count, 0)).toBe(
          inRange.filter((t) => t.kind === 'expense').length,
        );
      });

      it('returns empty results for an empty period and rejects reversed ranges', async () => {
        expect(
          (await repos.transactions.totals({ dateFrom: '2020-01-01', dateTo: '2020-01-31' }))
            .byCurrency,
        ).toEqual([]);
        await expect(
          repos.transactions.totals({ dateFrom: '2026-02-01', dateTo: '2026-01-01' }),
        ).rejects.toThrow();
      });

      it('orders byCategory by total descending', async () => {
        await repos.transactions.create(expense({ amountMinor: 100, categoryId: food.id }));
        await repos.transactions.create(expense({ amountMinor: 900, categoryId: rent.id }));

        const rows = await repos.transactions.byCategory({
          dateFrom: '2026-03-01',
          dateTo: '2026-03-31',
          kind: 'expense',
        });

        expect(rows.map((r) => [r.categoryName, r.total])).toEqual([
          ['Rent', 900n],
          ['Food', 100n],
        ]);
      });
    });

    describe('bulkInsert', () => {
      it('inserts all rows and returns the count', async () => {
        const n = await repos.transactions.bulkInsert(
          Array.from({ length: 1200 }, (_, i) => expense({ note: `row ${i}` })),
        );

        expect(n).toBe(1200);
        expect((await repos.transactions.list({})).total).toBe(1200);
        expect(await collect(repos.transactions.exportAll())).toHaveLength(1200);
        expect(await repos.transactions.bulkInsert([])).toBe(0);
      });

      it('is atomic: one invalid row → nothing inserted', async () => {
        const items = [expense(), expense(), expense({ amountMinor: -1 }), expense()];

        await expect(repos.transactions.bulkInsert(items)).rejects.toThrow();
        await expectDomainError(
          repos.transactions.bulkInsert([expense(), expense({ categoryId: salary.id })]),
          'CATEGORY_KIND_MISMATCH',
        );

        expect((await repos.transactions.list({})).total).toBe(0);
      });

      it('rejects duplicate ids atomically', async () => {
        const id = '0192f0c1-7a3b-7c3d-8e4f-1a2b3c4d5e6f';
        await repos.transactions.create(expense({ id }));

        await expectDomainError(
          repos.transactions.bulkInsert([expense(), expense({ id })]),
          'DUPLICATE_ID',
        );
        expect((await repos.transactions.list({})).total).toBe(1);
      });
    });

    describe('categories', () => {
      it('seeds defaults once', async () => {
        const fresh = await makeRepos();

        expect(await fresh.repos.categories.seedDefaults()).toBe(13);
        expect(await fresh.repos.categories.seedDefaults()).toBe(0);
        const list = await fresh.repos.categories.list();
        expect(list.filter((c) => c.kind === 'expense').map((c) => c.name)).toEqual([
          'Housing',
          'Food',
          'Transport',
          'Utilities',
          'Health',
          'Entertainment',
          'Shopping',
          'Other',
        ]);
        expect(list.filter((c) => c.kind === 'income')).toHaveLength(5);
        await fresh.close?.();
      });

      it('lists by kind and sort order, filters by kind', async () => {
        expect((await repos.categories.list()).map((c) => c.name)).toEqual([
          'Food',
          'Rent',
          'Salary',
        ]);
        expect((await repos.categories.list({ kind: 'income' })).map((c) => c.name)).toEqual([
          'Salary',
        ]);
      });

      it('enforces unique names per kind among active rows (case-insensitive)', async () => {
        await expectDomainError(
          repos.categories.create({ name: 'food', kind: 'expense', color: '#000000', icon: 'tag' }),
          'DUPLICATE_CATEGORY_NAME',
        );
        const incomeFood = await repos.categories.create({
          name: 'Food',
          kind: 'income',
          color: '#000000',
          icon: 'tag',
        });
        expect(incomeFood.name).toBe('Food');
        await expectDomainError(
          repos.categories.update(rent.id, { name: 'FOOD' }),
          'DUPLICATE_CATEGORY_NAME',
        );
      });

      it('renames and recolors', async () => {
        const updated = await repos.categories.update(food.id, {
          name: 'Groceries',
          color: '#abcdef',
        });

        expect(updated).toMatchObject({ name: 'Groceries', color: '#abcdef', icon: 'utensils' });
        expect(await repos.categories.get(food.id)).toEqual(updated);
      });

      it('blocks deleting a category in use until its transactions are reassigned', async () => {
        await repos.transactions.create(expense({ categoryId: food.id }));
        await repos.transactions.create(expense({ categoryId: food.id }));

        expect(await repos.categories.countTransactions(food.id)).toBe(2);
        await expectDomainError(repos.categories.softDelete(food.id), 'CATEGORY_IN_USE');
        await expectDomainError(
          repos.categories.reassignTransactions(food.id, salary.id),
          'CATEGORY_KIND_MISMATCH',
        );
        expect(await repos.categories.reassignTransactions(food.id, rent.id)).toBe(2);
        await repos.categories.softDelete(food.id);

        expect(await repos.categories.get(food.id)).toBeNull();
        expect((await repos.transactions.list({ categoryIds: [rent.id] })).total).toBe(2);
      });

      it('blocks changing the kind of a category in use', async () => {
        await repos.transactions.create(expense({ categoryId: food.id }));

        await expectDomainError(
          repos.categories.update(food.id, { kind: 'income' }),
          'CATEGORY_IN_USE',
        );
        expect((await repos.categories.update(rent.id, { kind: 'income' })).kind).toBe('income');
      });

      it('restores a deleted category unless its name is taken again', async () => {
        await repos.categories.softDelete(rent.id);
        await repos.categories.restore(rent.id);
        expect(await repos.categories.get(rent.id)).not.toBeNull();

        await repos.categories.softDelete(rent.id);
        await repos.categories.create({
          name: 'Rent',
          kind: 'expense',
          color: '#111111',
          icon: 'home',
        });
        await expectDomainError(repos.categories.restore(rent.id), 'DUPLICATE_CATEGORY_NAME');
        await expectDomainError(repos.categories.restore(food.id), 'NOT_FOUND');
      });

      it('reorders', async () => {
        const extra = await repos.categories.create({
          name: 'Fun',
          kind: 'expense',
          color: '#222222',
          icon: 'film',
        });

        await repos.categories.reorder([extra.id, rent.id, food.id]);

        expect((await repos.categories.list({ kind: 'expense' })).map((c) => c.name)).toEqual([
          'Fun',
          'Rent',
          'Food',
        ]);
        await expectDomainError(
          repos.categories.reorder(['0192f0c1-7a3b-7c3d-8e4f-000000000000']),
          'NOT_FOUND',
        );
      });

      it('new categories go to the end of their kind', async () => {
        const extra = await repos.categories.create({
          name: 'Fun',
          kind: 'expense',
          color: '#222222',
          icon: 'film',
        });

        expect(extra.sortOrder).toBe(2);
      });
    });

    describe('settings', () => {
      it('returns defaults, persists changes and validates values', async () => {
        const defaults = await repos.settings.getAll();
        expect(defaults).toMatchObject({
          baseCurrency: 'EUR',
          theme: 'system',
          autoLockMinutes: 5,
        });
        expect(defaults.schemaVersion).toBeGreaterThanOrEqual(1);

        await repos.settings.set('baseCurrency', 'USD');
        await repos.settings.set('theme', 'dark');
        await repos.settings.set('theme', 'light');

        expect(await repos.settings.get('baseCurrency')).toBe('USD');
        expect(await repos.settings.get('theme')).toBe('light');
        await expect(repos.settings.set('autoLockMinutes', 0)).rejects.toThrow();
        await expect(repos.settings.set('schemaVersion', 99)).rejects.toThrow();
      });
    });

    describe('snapshots', () => {
      it('replaceAll restores an exported snapshot exactly', async () => {
        await repos.transactions.create(expense({ note: 'one' }));
        const deleted = await repos.transactions.create(expense({ note: 'two' }));
        await repos.transactions.softDelete(deleted.id);
        await repos.settings.set('baseCurrency', 'USD');
        const snapshot = await repos.snapshots.exportSnapshot();
        const target = await makeRepos();
        await target.repos.categories.seedDefaults();

        await target.repos.snapshots.replaceAll(snapshot);

        expect(await target.repos.snapshots.exportSnapshot()).toEqual(snapshot);
        await target.close?.();
      });

      it('replaceAll rejects broken references and changes nothing', async () => {
        const snapshot = await repos.snapshots.exportSnapshot();
        const t = await repos.transactions.create(expense());
        const bad = {
          ...snapshot,
          transactions: [{ ...t, categoryId: '0192f0c1-7a3b-7c3d-8e4f-000000000000' }],
        };

        await expect(repos.snapshots.replaceAll(bad)).rejects.toThrow();
        expect((await repos.transactions.list({})).total).toBe(1);
      });

      it('mergeAll: newest updated_at wins, tombstones win over older edits, new rows are added', async () => {
        const a = await repos.transactions.create(expense({ note: 'a-old' }));
        const b = await repos.transactions.create(expense({ note: 'b' }));
        const base = await repos.snapshots.exportSnapshot();
        const later = (iso: string) => new Date(Date.parse(iso) + 60_000).toISOString();
        const incoming = {
          ...base,
          transactions: [
            {
              ...base.transactions.find((t) => t.id === a.id)!,
              note: 'a-new',
              updatedAt: later(a.updatedAt),
            },
            {
              ...base.transactions.find((t) => t.id === b.id)!,
              deletedAt: later(b.updatedAt),
              updatedAt: later(b.updatedAt),
            },
            { ...a, id: '0192f0c1-7a3b-7c3d-8e4f-1a2b3c4d5e6f', note: 'brand new' },
          ],
        };
        await repos.transactions.update(b.id, { note: 'b-local-edit' }); // older than the tombstone

        const result = await repos.snapshots.mergeAll(incoming);

        expect(result.transactions).toEqual({ inserted: 1, updated: 2 });
        expect((await repos.transactions.get(a.id))?.note).toBe('a-new');
        expect(await repos.transactions.get(b.id)).toBeNull();
        expect((await repos.transactions.list({ search: 'brand new' })).total).toBe(1);
      });

      it('mergeAll keeps local rows that are newer', async () => {
        const a = await repos.transactions.create(expense({ note: 'snapshot' }));
        const snapshot = await repos.snapshots.exportSnapshot();
        await repos.transactions.update(a.id, { note: 'local newer' });

        const result = await repos.snapshots.mergeAll(snapshot);

        expect(result.transactions).toEqual({ inserted: 0, updated: 0 });
        expect((await repos.transactions.get(a.id))?.note).toBe('local newer');
      });

      it('mergeAll renames an incoming category whose name clashes with a different local one', async () => {
        const other = await makeRepos();
        const theirs = await other.repos.categories.create({
          name: 'Food',
          kind: 'expense',
          color: '#333333',
          icon: 'tag',
        });
        const snapshot = await other.repos.snapshots.exportSnapshot();

        const result = await repos.snapshots.mergeAll(snapshot);

        expect(result.categories.inserted).toBe(1);
        expect((await repos.categories.get(theirs.id))?.name).toBe('Food (2)');
        await other.close?.();
      });
    });
  });
}
