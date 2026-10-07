import { isDomainError, type Repositories } from '@budget/core';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useRepositories, useServices } from '@/di';

/** Query key roots. Invalidating a root refreshes every query below it. */
export const queryKeys = {
  categories: ['categories'] as const,
  transactions: ['transactions'] as const,
  dashboard: ['dashboard'] as const,
  settings: ['settings'] as const,
};

/** Everything derived from the ledger; invalidated after any data change. */
export const LEDGER_KEYS: QueryKey[] = [
  queryKeys.categories,
  queryKeys.transactions,
  queryKeys.dashboard,
];

/**
 * A repository write triggered by the user: runs `fn`, makes it durable right away (vault flush),
 * then refreshes the affected queries.
 */
export function useRepoMutation<TVars, TResult>(
  fn: (repos: Repositories, vars: TVars) => Promise<TResult>,
  invalidate: QueryKey[] = LEDGER_KEYS,
) {
  const repos = useRepositories();
  const { vault } = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: TVars) => {
      const result = await fn(repos, vars);
      await vault.flush();
      return result;
    },
    onSuccess: async () => {
      await Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
  });
}

/** Translated, generic message for a failed operation (details never reach the UI; A10). */
export function useErrorMessage() {
  const { t } = useTranslation();
  return (err: unknown): string =>
    isDomainError(err)
      ? t(`errors.${err.code}`, { defaultValue: t('app.genericError') })
      : t('app.genericError');
}
