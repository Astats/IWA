import {
  customRange,
  DATE_PRESETS,
  idSchema,
  isValidIsoDate,
  kindSchema,
  presetRange,
  SORT_KEYS,
  type DatePreset,
  type Kind,
  type SortKey,
  type TransactionQuery,
} from '@budget/core';

export const PAGE_SIZES = [25, 50, 100] as const;

/**
 * List state persisted in the URL. Only non-sensitive values live here (SEC-W04): never amounts,
 * notes or the free-text search term.
 */
export interface ListParams {
  kind: Kind | null;
  categoryIds: string[];
  preset: DatePreset | null;
  dateFrom: string | null;
  dateTo: string | null;
  sortBy: SortKey;
  sortDir: 'asc' | 'desc';
  page: number;
  pageSize: (typeof PAGE_SIZES)[number];
}

export const DEFAULT_LIST_PARAMS: ListParams = {
  kind: null,
  categoryIds: [],
  preset: null,
  dateFrom: null,
  dateTo: null,
  sortBy: 'date',
  sortDir: 'desc',
  page: 0,
  pageSize: 50,
};

/** Parses URL search params defensively (they are user-controlled input): invalid → default. */
export function parseListParams(search: URLSearchParams): ListParams {
  const kind = kindSchema.safeParse(search.get('kind'));
  const sort = search.get('sort');
  const dir = search.get('dir');
  const preset = search.get('preset');
  const page = Number(search.get('page'));
  const size = Number(search.get('size'));
  const date = (key: string) => {
    const v = search.get(key);
    return v && isValidIsoDate(v) ? v : null;
  };
  return {
    kind: kind.success ? kind.data : null,
    categoryIds: (search.get('cat') ?? '')
      .split(',')
      .filter((id) => idSchema.safeParse(id).success)
      .slice(0, 100),
    preset: (DATE_PRESETS as readonly string[]).includes(preset ?? '')
      ? (preset as DatePreset)
      : null,
    dateFrom: date('from'),
    dateTo: date('to'),
    sortBy: (SORT_KEYS as readonly string[]).includes(sort ?? '') ? (sort as SortKey) : 'date',
    sortDir: dir === 'asc' ? 'asc' : 'desc',
    page: Number.isInteger(page) && page > 0 && page < 100_000 ? page : 0,
    pageSize: (PAGE_SIZES as readonly number[]).includes(size)
      ? (size as ListParams['pageSize'])
      : 50,
  };
}

/** Serializes only values that differ from the defaults, keeping URLs short. */
export function toSearchParams(params: ListParams): URLSearchParams {
  const out = new URLSearchParams();
  if (params.kind) out.set('kind', params.kind);
  if (params.categoryIds.length > 0) out.set('cat', params.categoryIds.join(','));
  if (params.preset) out.set('preset', params.preset);
  if (params.preset === 'custom') {
    if (params.dateFrom) out.set('from', params.dateFrom);
    if (params.dateTo) out.set('to', params.dateTo);
  }
  if (params.sortBy !== 'date') out.set('sort', params.sortBy);
  if (params.sortDir !== 'desc') out.set('dir', params.sortDir);
  if (params.page > 0) out.set('page', String(params.page));
  if (params.pageSize !== 50) out.set('size', String(params.pageSize));
  return out;
}

/** The date range a preset selects, relative to `today` (YYYY-MM-DD). */
export function dateRangeFor(
  params: Pick<ListParams, 'preset' | 'dateFrom' | 'dateTo'>,
  today: string,
): { dateFrom?: string; dateTo?: string } {
  if (!params.preset) return {};
  if (params.preset === 'custom') {
    if (params.dateFrom && params.dateTo) {
      return customRange(params.dateFrom, params.dateTo) ?? {};
    }
    return {
      ...(params.dateFrom ? { dateFrom: params.dateFrom } : {}),
      ...(params.dateTo ? { dateTo: params.dateTo } : {}),
    };
  }
  return presetRange(params.preset, today);
}

/** Repository query for the current list state plus the in-memory search term. */
export function toTransactionQuery(
  params: ListParams,
  search: string,
  today: string,
): TransactionQuery {
  const trimmed = search.trim();
  return {
    ...(params.kind ? { kind: params.kind } : {}),
    ...(params.categoryIds.length > 0 ? { categoryIds: params.categoryIds } : {}),
    ...dateRangeFor(params, today),
    ...(trimmed ? { search: trimmed.slice(0, 200) } : {}),
    sortBy: params.sortBy,
    sortDir: params.sortDir,
    limit: params.pageSize,
    offset: params.page * params.pageSize,
  };
}
