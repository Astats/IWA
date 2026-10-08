import {
  BackupPayloadError,
  backupFileName,
  createBackup,
  readBackup,
  restoreBackup,
  type BackupHeader,
  type BackupPayload,
  type RestoreMode,
} from '@budget/backup';
import {
  DecryptionError,
  FormatError,
  KdfPolicyError,
  UnsupportedVersionError,
} from '@budget/crypto';
import { useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, Download, RotateCcw } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Field } from '@/components/form/Field';
import { PassphraseInput } from '@/components/form/PassphraseInput';
import { PageHeader } from '@/components/layout/PageHeader';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useRepositories, useServices } from '@/di';
import { useFormatters } from '@/hooks/useFormatters';
import { downloadFile } from '@/lib/download';

const PRE_RESTORE_FILE = 'pre-restore.bgtb';
const BACKUP_TYPE = 'application/octet-stream';

/** Maps backup errors to user messages; never shows internal details (A10, SEC-W09). */
function restoreErrorKey(err: unknown): string {
  if (err instanceof UnsupportedVersionError) return 'backup.errors.newerVersion';
  if (err instanceof DecryptionError) return 'backup.errors.wrongPassphrase';
  if (err instanceof KdfPolicyError || err instanceof FormatError)
    return 'backup.errors.notABackup';
  if (err instanceof BackupPayloadError) return 'backup.errors.invalidContents';
  return 'app.genericError';
}

function DownloadBackup() {
  const { t } = useTranslation();
  const repos = useRepositories();
  const services = useServices();
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (!(await services.vault.verifyPassphrase(passphrase))) {
        setMessage({ ok: false, text: t('backup.errors.currentPassphrase') });
        return;
      }
      const bytes = await createBackup(repos, passphrase, {
        kdfParams: services.kdfParams,
        appVersion: services.appVersion,
        now: services.now,
      });
      downloadFile(backupFileName(services.now()), bytes, BACKUP_TYPE);
      setPassphrase('');
      setMessage({ ok: true, text: t('backup.downloaded') });
    } catch {
      setMessage({ ok: false, text: t('app.genericError') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t('backup.downloadTitle')}</h2>
        </CardTitle>
        <CardDescription>{t('backup.downloadIntro')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={(e) => void run(e)} noValidate>
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
          {message && (
            <p
              role={message.ok ? 'status' : 'alert'}
              className={message.ok ? 'text-sm' : 'text-sm font-medium text-destructive'}
            >
              {message.text}
            </p>
          )}
          <Button type="submit" className="justify-self-start" disabled={busy || !passphrase}>
            <Download aria-hidden /> {busy ? t('backup.working') : t('backup.download')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

type RestoreStage =
  | { type: 'form' }
  | { type: 'confirm'; header: BackupHeader; payload: BackupPayload }
  | { type: 'done'; mode: RestoreMode; preRestore: Uint8Array | null };

function RestoreBackup() {
  const { t } = useTranslation();
  const repos = useRepositories();
  const services = useServices();
  const queryClient = useQueryClient();
  const fmt = useFormatters();
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [mode, setMode] = useState<RestoreMode>('merge');
  const [stage, setStage] = useState<RestoreStage>({ type: 'form' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { header, payload } = await readBackup(bytes, passphrase, {
        minKdf: services.kdfParams,
      });
      setStage({ type: 'confirm', header, payload });
    } catch (err) {
      setError(t(restoreErrorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  const apply = async (payload: BackupPayload) => {
    setBusy(true);
    setError(null);
    try {
      // Safety copy of the current data before anything changes (BUILD_PLAN 2.3).
      const preRestore = await createBackup(repos, passphrase, {
        kdfParams: services.kdfParams,
        appVersion: services.appVersion,
        now: services.now,
      });
      await services.vault.saveFile(PRE_RESTORE_FILE, preRestore);
      await restoreBackup(repos, payload, mode);
      await services.vault.flush();
      await queryClient.invalidateQueries();
      setStage({ type: 'done', mode, preRestore });
      setPassphrase('');
      setFile(null);
    } catch (err) {
      // Restores run in one DB transaction: on failure nothing was changed.
      setError(t(restoreErrorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t('backup.restoreTitle')}</h2>
        </CardTitle>
        <CardDescription>{t('backup.restoreIntro')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {stage.type === 'form' && (
          <form className="grid gap-3" onSubmit={(e) => void open(e)} noValidate>
            <div className="grid gap-1.5">
              <Label htmlFor={fileId}>{t('backup.file')}</Label>
              <input
                id={fileId}
                type="file"
                accept=".bgtb,application/octet-stream"
                className="text-sm file:mr-2 file:rounded-md file:border file:bg-transparent file:px-2 file:py-1"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                }}
              />
            </div>
            <Field label={t('backup.backupPassphrase')} hint={t('backup.backupPassphraseHint')}>
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
            <fieldset className="grid gap-1 text-sm">
              <legend className="mb-1 font-medium">{t('backup.mode')}</legend>
              {(['merge', 'replace'] as const).map((m) => (
                <label key={m} className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="restore-mode"
                    className="mt-0.5 size-4 accent-primary"
                    checked={mode === m}
                    onChange={() => {
                      setMode(m);
                    }}
                  />
                  <span>
                    <span className="font-medium">{t(`backup.modes.${m}`)}</span> —{' '}
                    {t(`backup.modes.${m}Hint`)}
                  </span>
                </label>
              ))}
            </fieldset>
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button
              type="submit"
              className="justify-self-start"
              disabled={busy || !file || !passphrase}
            >
              <DatabaseBackup aria-hidden /> {busy ? t('backup.working') : t('backup.openBackup')}
            </Button>
          </form>
        )}

        {stage.type === 'confirm' && (
          <div className="grid gap-3" role="group" aria-label={t('backup.confirmTitle')}>
            <p className="text-sm">
              {t('backup.summary', {
                date: fmt.date(stage.header.createdAt.slice(0, 10)),
                transactions: stage.payload.transactions.filter((x) => x.deletedAt === null).length,
                categories: stage.payload.categories.filter((x) => x.deletedAt === null).length,
              })}
            </p>
            <Alert variant={mode === 'replace' ? 'destructive' : 'default'}>
              <AlertDescription>
                {t(mode === 'replace' ? 'backup.replaceWarning' : 'backup.mergeInfo')}
              </AlertDescription>
            </Alert>
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={mode === 'replace' ? 'destructive' : 'default'}
                disabled={busy}
                onClick={() => void apply(stage.payload)}
              >
                <RotateCcw aria-hidden />{' '}
                {t(mode === 'replace' ? 'backup.confirmReplace' : 'backup.confirmMerge')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setStage({ type: 'form' });
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}

        {stage.type === 'done' && (
          <div className="grid gap-3">
            <p role="status" className="text-sm">
              {t(stage.mode === 'replace' ? 'backup.replaced' : 'backup.merged')}
            </p>
            {stage.preRestore && (
              <Button
                type="button"
                variant="outline"
                className="justify-self-start"
                onClick={() => {
                  if (stage.preRestore)
                    downloadFile(
                      backupFileName(services.now()).replace('budget-backup', 'budget-pre-restore'),
                      stage.preRestore,
                      BACKUP_TYPE,
                    );
                }}
              >
                <Download aria-hidden /> {t('backup.downloadPreRestore')}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              className="justify-self-start"
              onClick={() => {
                setStage({ type: 'form' });
              }}
            >
              {t('backup.restoreAnother')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function BackupPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('backup.title')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <DownloadBackup />
        <RestoreBackup />
      </div>
    </>
  );
}
