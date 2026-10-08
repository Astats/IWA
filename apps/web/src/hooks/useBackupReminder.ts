import { backupReminder, type BackupReminder } from '@budget/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useRepositories, useServices } from '@/di';

import { queryKeys } from './useRepoMutation';
import { useSettings, useUpdateSettings } from './useSettings';

/** How often the reminder is re-evaluated while the app is open. */
export const REMINDER_CHECK_MS = 60_000;

/** A clock that ticks every minute, so a reminder appears without a reload. */
function useMinuteClock(now: () => Date): Date {
  const [time, setTime] = useState(now);
  useEffect(() => {
    const timer = setInterval(() => {
      setTime(now());
    }, REMINDER_CHECK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [now]);
  return time;
}

/** Backup reminder state (BUILD_PLAN 3.5), or null while settings load. */
export function useBackupReminder(): BackupReminder | null {
  const repos = useRepositories();
  const services = useServices();
  const { data: settings } = useSettings();
  const now = useMinuteClock(services.now);
  // Under the transactions root, so it refreshes whenever the ledger changes.
  const { data: hasData } = useQuery({
    queryKey: [...queryKeys.transactions, 'has-data'],
    queryFn: async () => (await repos.transactions.list({ limit: 1 })).total > 0,
  });
  if (!settings || hasData === undefined) return null;
  return backupReminder({
    frequency: settings.backupFrequency,
    lastBackupAt: settings.lastBackupAt,
    hasData,
    now,
  });
}

/** Records a successful backup (cloud upload or file download) as the last backup time. */
export function useRecordBackup() {
  const services = useServices();
  const update = useUpdateSettings();
  return () => update.mutateAsync({ lastBackupAt: services.now().toISOString() });
}
