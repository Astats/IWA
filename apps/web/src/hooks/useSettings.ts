import type { Settings } from '@budget/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useRepositories, useServices } from '@/di';

export const settingsKey = ['settings'] as const;

export function useSettings() {
  const repos = useRepositories();
  return useQuery({ queryKey: settingsKey, queryFn: () => repos.settings.getAll() });
}

export function useUpdateSettings() {
  const repos = useRepositories();
  const { vault } = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<Omit<Settings, 'schemaVersion'>>) => {
      for (const [key, value] of Object.entries(patch) as Array<
        [keyof Omit<Settings, 'schemaVersion'>, Settings[keyof Settings]]
      >) {
        await repos.settings.set(key, value);
      }
      // An explicit save is durable right away (no debounce window before a tab close).
      await vault.flush();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsKey }),
  });
}
