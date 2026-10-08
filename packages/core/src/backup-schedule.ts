/*
 * Backup reminders (BUILD_PLAN 3.5). Pure scheduling logic: given the chosen frequency and the
 * last successful backup, decide whether a reminder is due. The app never backs up silently on
 * the web (a backup needs the passphrase), so "due" only ever means "remind the user".
 */

export const BACKUP_FREQUENCIES = ['manual', 'daily', 'weekly'] as const;
export type BackupFrequency = (typeof BACKUP_FREQUENCIES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS: Record<Exclude<BackupFrequency, 'manual'>, number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
};

export type BackupReminder =
  /** Reminders are off (manual backups only). */
  | { state: 'off' }
  /** Nothing to back up yet. */
  | { state: 'empty' }
  /** Never backed up although there is data. */
  | { state: 'never' }
  /** The interval since the last backup has passed. */
  | { state: 'overdue'; since: Date }
  /** Up to date; the next reminder is due at `dueAt`. */
  | { state: 'ok'; dueAt: Date };

export interface BackupReminderInput {
  frequency: BackupFrequency;
  /** ISO 8601 instant of the last successful backup, or null. */
  lastBackupAt: string | null;
  /** True when the ledger holds at least one transaction. */
  hasData: boolean;
  now: Date;
}

/** When the next backup is due, or null when reminders are off or there was no backup yet. */
export function nextBackupDue(
  frequency: BackupFrequency,
  lastBackupAt: string | null,
): Date | null {
  if (frequency === 'manual' || lastBackupAt === null) return null;
  const last = Date.parse(lastBackupAt);
  if (Number.isNaN(last)) return null;
  return new Date(last + INTERVAL_MS[frequency]);
}

export function backupReminder({
  frequency,
  lastBackupAt,
  hasData,
  now,
}: BackupReminderInput): BackupReminder {
  if (frequency === 'manual') return { state: 'off' };
  if (!hasData) return { state: 'empty' };
  const due = nextBackupDue(frequency, lastBackupAt);
  if (due === null) return { state: 'never' };
  // A last backup "in the future" (clock changed) counts as just made, not as overdue.
  if (now.getTime() >= due.getTime()) return { state: 'overdue', since: due };
  return { state: 'ok', dueAt: due };
}

/** True when the reminder banner should be shown. */
export function isBackupReminderDue(reminder: BackupReminder): boolean {
  return reminder.state === 'never' || reminder.state === 'overdue';
}
