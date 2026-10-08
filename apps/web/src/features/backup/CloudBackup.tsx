import {
  backupFileName,
  createBackup,
  ProviderError,
  uploadBackup,
  type BackupProvider,
  type RemoteBackup,
} from '@budget/backup';
import { DEFAULT_BACKUP_RETENTION, settingsSchema } from '@budget/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudUpload, LogIn, LogOut, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Field } from '@/components/form/Field';
import { PassphraseInput } from '@/components/form/PassphraseInput';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useRepositories, useServices } from '@/di';
import { useRecordBackup } from '@/hooks/useBackupReminder';
import { useFormatters } from '@/hooks/useFormatters';
import { useSettings, useUpdateSettings } from '@/hooks/useSettings';

import { providerErrorKey } from './provider-errors';
import { RestoreFlow } from './RestoreFlow';

export const cloudBackupsKey = (providerId: string) => ['cloud-backups', providerId] as const;

type Message = { ok: boolean; text: string } | null;

function errorText(t: (key: string) => string, err: unknown): string {
  return t(err instanceof ProviderError ? providerErrorKey(err) : 'app.genericError');
}

function StatusMessage({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <p
      role={message.ok ? 'status' : 'alert'}
      className={message.ok ? 'text-sm' : 'text-sm font-medium text-destructive'}
    >
      {message.text}
    </p>
  );
}

function RetentionForm() {
  const { t } = useTranslation();
  const settings = useSettings();
  const update = useUpdateSettings();
  const [value, setValue] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const current = settings.data?.backupRetention ?? DEFAULT_BACKUP_RETENTION;
  const shown = value ?? String(current);
  const parsed = settingsSchema.shape.backupRetention.safeParse(Number(shown));
  const invalid = shown.trim() === '' || !parsed.success;

  const save = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (invalid) return;
    setMessage(null);
    try {
      await update.mutateAsync({ backupRetention: parsed.data });
      setValue(null);
      setMessage({ ok: true, text: t('common.saved') });
    } catch {
      setMessage({ ok: false, text: t('app.genericError') });
    }
  };

  return (
    <form className="flex flex-wrap items-start gap-2" onSubmit={(e) => void save(e)} noValidate>
      <Field
        label={t('backup.cloud.retention')}
        hint={t('backup.cloud.retentionHint')}
        error={invalid ? t('backup.cloud.retentionInvalid') : undefined}
        className="w-64"
      >
        {(c) => (
          <Input
            {...c}
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={shown}
            onChange={(e) => {
              setValue(e.target.value);
              setMessage(null);
            }}
          />
        )}
      </Field>
      <Button
        type="submit"
        variant="outline"
        className="mt-6"
        disabled={invalid || update.isPending || value === null}
      >
        {t('common.save')}
      </Button>
      <div className="mt-7 basis-full sm:basis-auto">
        <StatusMessage message={message} />
      </div>
    </form>
  );
}

function BackUpNow({
  provider,
  name,
  onError,
}: {
  provider: BackupProvider;
  name: string;
  onError: (err: unknown) => void;
}) {
  const { t } = useTranslation();
  const repos = useRepositories();
  const services = useServices();
  const settings = useSettings();
  const queryClient = useQueryClient();
  const recordBackup = useRecordBackup();
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const run = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (!(await services.vault.verifyPassphrase(passphrase))) {
        setMessage({ ok: false, text: t('backup.errors.currentPassphrase') });
        return;
      }
      // Encrypted on this device; the provider only ever receives ciphertext (AD13).
      const bytes = await createBackup(repos, passphrase, {
        kdfParams: services.kdfParams,
        appVersion: services.appVersion,
        now: services.now,
      });
      const keep = settings.data?.backupRetention ?? DEFAULT_BACKUP_RETENTION;
      const result = await uploadBackup(provider, backupFileName(services.now()), bytes, keep);
      await recordBackup();
      setPassphrase('');
      const removed = result.retention?.deleted.length ?? 0;
      setMessage({
        ok: true,
        text: [
          t('backup.cloud.backedUp', { provider: name }),
          removed > 0 ? t('backup.cloud.retentionDeleted', { count: removed }) : '',
        ]
          .filter(Boolean)
          .join(' '),
      });
    } catch (err) {
      setMessage({ ok: false, text: errorText(t, err) });
      onError(err);
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: cloudBackupsKey(provider.id) });
    }
  };

  return (
    <form className="grid gap-2" onSubmit={(e) => void run(e)} noValidate>
      <Field label={t('backup.currentPassphrase')}>
        {(c) => (
          <PassphraseInput
            {...c}
            value={passphrase}
            onChange={(e) => {
              setPassphrase(e.target.value);
            }}
          />
        )}
      </Field>
      <StatusMessage message={message} />
      <Button type="submit" className="justify-self-start" disabled={busy || !passphrase}>
        <CloudUpload aria-hidden /> {busy ? t('backup.working') : t('backup.cloud.backUpNow')}
      </Button>
    </form>
  );
}

function RemoteBackupItem({
  provider,
  item,
  onError,
}: {
  provider: BackupProvider;
  item: RemoteBackup;
  onError: (err: unknown) => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'idle' | 'restore' | 'confirm-delete'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = fmt.dateTime(item.createdAt);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await provider.delete(item.id);
    } catch (err) {
      setError(errorText(t, err));
      onError(err);
      setBusy(false);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: cloudBackupsKey(provider.id) });
  };

  return (
    <li className="grid gap-2 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="me-auto text-sm">
          <span className="font-medium">{label}</span>{' '}
          <span className="text-muted-foreground">({fmt.fileSize(item.size)})</span>
        </span>
        {mode === 'idle' && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t('backup.cloud.restoreLabel', { date: label })}
              onClick={() => {
                setMode('restore');
              }}
            >
              <RotateCcw aria-hidden /> {t('backup.cloud.restore')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={t('backup.cloud.deleteLabel', { date: label })}
              onClick={() => {
                setMode('confirm-delete');
              }}
            >
              <Trash2 aria-hidden /> {t('common.delete')}
            </Button>
          </>
        )}
      </div>
      {mode === 'confirm-delete' && (
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label={t('backup.cloud.confirmDeleteTitle')}
        >
          <span className="text-sm">{t('backup.cloud.confirmDelete', { date: label })}</span>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => void remove()}
          >
            {t('backup.cloud.deleteForever')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setMode('idle');
            }}
          >
            {t('common.cancel')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      {mode === 'restore' && (
        <div className="rounded-lg border p-3">
          <RestoreFlow
            source={<p className="text-sm">{t('backup.cloud.restoreFrom', { date: label })}</p>}
            canOpen
            load={() => provider.download(item.id)}
            onError={onError}
            onCancel={() => {
              setMode('idle');
            }}
          />
        </div>
      )}
    </li>
  );
}

function ProviderPanel({ provider }: { provider: BackupProvider }) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const headingId = useId();
  const name = t(`backup.cloud.providers.${provider.id}`);
  const [connected, setConnected] = useState(() => provider.isConnected());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const backups = useQuery({
    queryKey: cloudBackupsKey(provider.id),
    queryFn: () => provider.list(),
    enabled: connected,
    gcTime: 0,
  });

  // Load the provider's sign-in library now, so Connect can open its window from the click.
  useEffect(() => {
    provider.prepare?.().catch(() => undefined);
  }, [provider]);

  /** After any failure: an expired or revoked session shows as disconnected. */
  const syncConnection = (err: unknown) => {
    const gone = err instanceof ProviderError && err.code === 'NOT_FOUND';
    if (gone) void queryClient.invalidateQueries({ queryKey: cloudBackupsKey(provider.id) });
    const stillConnected = provider.isConnected();
    // The failing form unmounts with the session or the vanished item; say why at panel level.
    if (gone || !stillConnected) setMessage({ ok: false, text: errorText(t, err) });
    setConnected(stillConnected);
  };

  const connect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await provider.connect();
      setConnected(true);
    } catch (err) {
      setMessage({ ok: false, text: errorText(t, err) });
      syncConnection(err);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await provider.disconnect();
    } finally {
      queryClient.removeQueries({ queryKey: cloudBackupsKey(provider.id) });
      setConnected(provider.isConnected());
      setBusy(false);
      setMessage({ ok: true, text: t('backup.cloud.disconnected', { provider: name }) });
    }
  };

  const listError = backups.error;
  if (listError && connected && !provider.isConnected()) setConnected(false);
  const items = backups.data ?? [];
  const latest = items[0];

  return (
    <section aria-labelledby={headingId} className="grid gap-3 border-t pt-4 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="me-auto font-medium">
          {name}
          <span className="ms-2 text-sm font-normal text-muted-foreground">
            {connected ? t('backup.cloud.connected') : t('backup.cloud.notConnected')}
          </span>
        </h3>
        {connected ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            aria-label={t('backup.cloud.disconnectLabel', { provider: name })}
            onClick={() => void disconnect()}
          >
            <LogOut aria-hidden /> {t('backup.cloud.disconnect')}
          </Button>
        ) : (
          <Button
            type="button"
            disabled={busy}
            aria-label={busy ? undefined : t('backup.cloud.connectLabel', { provider: name })}
            onClick={() => void connect()}
          >
            <LogIn aria-hidden /> {busy ? t('backup.working') : t('backup.cloud.connect')}
          </Button>
        )}
      </div>
      <StatusMessage message={message} />
      {!connected && listError && !message && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errorText(t, listError)}
        </p>
      )}
      {connected && (
        <>
          <p className="text-sm">
            {backups.isPending
              ? t('app.loading')
              : latest
                ? t('backup.cloud.lastBackup', { date: fmt.dateTime(latest.createdAt) })
                : t('backup.cloud.noBackups')}
          </p>
          <BackUpNow provider={provider} name={name} onError={syncConnection} />
          {listError && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {errorText(t, listError)}
            </p>
          )}
          {items.length > 0 && (
            <div className="grid gap-1">
              <h4 className="text-sm font-medium">{t('backup.cloud.remoteBackups')}</h4>
              <ul
                className="divide-y"
                aria-label={t('backup.cloud.remoteBackupsOf', { provider: name })}
              >
                {items.map((item) => (
                  <RemoteBackupItem
                    key={item.id}
                    provider={provider}
                    item={item}
                    onError={syncConnection}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Cloud backup providers (BUILD_PLAN 3.1): connect, back up now, list, restore, delete. */
export function CloudBackup() {
  const { t } = useTranslation();
  const { backupProviders } = useServices();
  const providers = backupProviders.all();
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>
          <h2>{t('backup.cloud.title')}</h2>
        </CardTitle>
        <CardDescription>{t('backup.cloud.intro')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('backup.cloud.noneConfigured')}</p>
        ) : (
          <>
            <RetentionForm />
            {providers.map((p) => (
              <ProviderPanel key={p.id} provider={p} />
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
