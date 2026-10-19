import { BACKUP_FREQUENCIES, type BackupFrequency } from '@budget/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';

import { Field, NativeSelect } from '@/components/form/Field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useBackupReminder } from '@/hooks/useBackupReminder';
import { useFormatters } from '@/hooks/useFormatters';
import { useSettings, useUpdateSettings } from '@/hooks/useSettings';

/**
 * Reminder banner (BUILD_PLAN 3.5) shown on every screen when a backup is due. It only reminds:
 * on the web a backup needs the passphrase, so nothing runs in the background.
 */
export function BackupReminderBanner() {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const reminder = useBackupReminder();
  const { pathname } = useLocation();
  if (!reminder || (reminder.state !== 'never' && reminder.state !== 'overdue')) return null;
  return (
    <Alert className="m-4 mb-0 w-auto" role="status">
      <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          {reminder.state === 'never'
            ? t('backup.reminder.never')
            : t('backup.reminder.overdue', { date: fmt.dateTime(reminder.since.toISOString()) })}
        </span>
        {pathname !== '/backup' && (
          <Link to="/backup" className="font-medium underline underline-offset-4">
            {t('backup.reminder.backUpNow')}
          </Link>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** Last successful backup and reminder frequency, on the Backup screen. */
export function BackupStatus() {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const { data: settings } = useSettings();
  const reminder = useBackupReminder();
  const update = useUpdateSettings();
  const [saved, setSaved] = useState(false);
  if (!settings) return null;

  const change = async (frequency: BackupFrequency) => {
    setSaved(false);
    await update.mutateAsync({ backupFrequency: frequency });
    setSaved(true);
  };

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>
          <h2>{t('backup.status.title')}</h2>
        </CardTitle>
        <CardDescription>{t('backup.status.intro')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1 text-sm">
          <span className="font-medium">{t('backup.status.last')}</span>
          <span>
            {settings.lastBackupAt ? fmt.dateTime(settings.lastBackupAt) : t('backup.status.never')}
          </span>
          {reminder?.state === 'ok' && (
            <span className="text-muted-foreground">
              {t('backup.status.next', { date: fmt.dateTime(reminder.dueAt.toISOString()) })}
            </span>
          )}
        </div>
        <Field label={t('backup.status.frequency')} hint={t('backup.status.frequencyHint')}>
          {(c) => (
            <NativeSelect
              {...c}
              value={settings.backupFrequency}
              disabled={update.isPending}
              onChange={(e) => {
                void change(e.target.value as BackupFrequency);
              }}
            >
              {BACKUP_FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {t(`backup.status.frequencies.${f}`)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        {saved && (
          <p role="status" className="text-sm sm:col-span-2">
            {t('common.saved')}
          </p>
        )}
        {update.isError && (
          <p role="alert" className="text-sm font-medium text-destructive sm:col-span-2">
            {t('app.genericError')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
