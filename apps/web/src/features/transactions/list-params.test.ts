import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIST_PARAMS,
  parseListParams,
  toSearchParams,
  toTransactionQuery,
  type ListParams,
} from './list-params';

const ID = '0192f0c1-7a3b-7c3d-8e4f-1a2b3c4d5e6f';

describe('list params', () => {
  it('defaults for an empty URL', () => {
    expect(parseListParams(new URLSearchParams())).toEqual(DEFAULT_LIST_PARAMS);
    expect(toSearchParams(DEFAULT_LIST_PARAMS).toString()).toBe('');
  });

  it('round-trips every field', () => {
    const params: ListParams = {
      kind: 'income',
      categoryIds: [ID],
      preset: 'custom',
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      sortBy: 'amount',
      sortDir: 'asc',
      page: 3,
      pageSize: 100,
    };

    expect(parseListParams(toSearchParams(params))).toEqual(params);
  });

  it('ignores invalid or hostile values', () => {
    const parsed = parseListParams(
      new URLSearchParams({
        kind: 'transfer',
        cat: `${ID},not-an-id,' OR 1=1 --`,
        preset: 'forever',
        from: '2026-02-30',
        sort: 'note; DROP TABLE x',
        dir: 'sideways',
        page: '-4',
        size: '9999',
      }),
    );

    expect(parsed).toEqual({ ...DEFAULT_LIST_PARAMS, categoryIds: [ID] });
  });

  it('never serializes a search term (SEC-W04)', () => {
    const url = toSearchParams({ ...DEFAULT_LIST_PARAMS, kind: 'expense' }).toString();

    expect(url).toBe('kind=expense');
    expect(url).not.toMatch(/q=|search=/);
  });

  it('drops custom dates unless the preset is custom', () => {
    expect(
      toSearchParams({
        ...DEFAULT_LIST_PARAMS,
        preset: 'this-month',
        dateFrom: '2026-01-01',
      }).toString(),
    ).toBe('preset=this-month');
  });
});

describe('toTransactionQuery', () => {
  it('maps presets to date ranges relative to today', () => {
    expect(
      toTransactionQuery({ ...DEFAULT_LIST_PARAMS, preset: 'last-month' }, '', '2026-03-15'),
    ).toMatchObject({
      dateFrom: '2026-02-01',
      dateTo: '2026-02-28',
    });
  });

  it('supports open-ended and reversed custom ranges', () => {
    const base = { ...DEFAULT_LIST_PARAMS, preset: 'custom' as const };

    expect(toTransactionQuery({ ...base, dateFrom: '2026-01-01' }, '', '2026-03-15')).toMatchObject(
      { dateFrom: '2026-01-01' },
    );
    expect(toTransactionQuery({ ...base, dateTo: '2026-01-01' }, '', '2026-03-15')).toMatchObject({
      dateTo: '2026-01-01',
    });
    expect(
      toTransactionQuery(
        { ...base, dateFrom: '2026-02-01', dateTo: '2026-01-01' },
        '',
        '2026-03-15',
      ),
    ).not.toHaveProperty('dateFrom');
  });

  it('includes the trimmed search term, filters, sort and paging', () => {
    expect(
      toTransactionQuery(
        { ...DEFAULT_LIST_PARAMS, kind: 'expense', categoryIds: [ID], page: 2, pageSize: 25 },
        '  rent ',
        '2026-03-15',
      ),
    ).toEqual({
      kind: 'expense',
      categoryIds: [ID],
      search: 'rent',
      sortBy: 'date',
      sortDir: 'desc',
      limit: 25,
      offset: 50,
    });
  });
});
