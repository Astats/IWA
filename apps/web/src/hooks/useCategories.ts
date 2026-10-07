import type { Category, Kind } from '@budget/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useRepositories } from '@/di';

import { queryKeys } from './useRepoMutation';

/** Active categories (sorted by kind, order, name). */
export function useCategories() {
  const repos = useRepositories();
  return useQuery({ queryKey: queryKeys.categories, queryFn: () => repos.categories.list() });
}

export function useCategoriesByKind(kind: Kind | undefined): Category[] {
  const { data } = useCategories();
  return useMemo(() => (data ?? []).filter((c) => !kind || c.kind === kind), [data, kind]);
}

export function useCategoryMap(): Map<string, Category> {
  const { data } = useCategories();
  return useMemo(() => new Map((data ?? []).map((c) => [c.id, c])), [data]);
}
