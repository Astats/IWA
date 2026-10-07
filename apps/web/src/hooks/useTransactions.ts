import type { TransactionQuery } from '@budget/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useRepositories } from '@/di';

import { queryKeys } from './useRepoMutation';

export function useTransactionList(query: TransactionQuery) {
  const repos = useRepositories();
  return useQuery({
    queryKey: [...queryKeys.transactions, 'list', query],
    queryFn: () => repos.transactions.list(query),
    placeholderData: keepPreviousData,
  });
}

export function useTransaction(id: string | undefined) {
  const repos = useRepositories();
  return useQuery({
    queryKey: [...queryKeys.transactions, 'one', id],
    queryFn: () => (id ? repos.transactions.get(id) : Promise.resolve(null)),
    enabled: !!id,
    // Never show a cached (possibly outdated) row in the editor: a later refetch would remount the
    // form while the user is interacting with it.
    gcTime: 0,
  });
}
