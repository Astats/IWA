import {
  BackupPayloadError,
  backupFileName,
  createBackup,
  ProviderError,
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
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Field } from '@/components/form/Field';
import { PassphraseInput } from '@/components/form/PassphraseInput';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useRepositories, useServices } from '@/di';
import { useFormatters } from '@/hooks/useFormatters';
import { downloadFile } from '@/lib/download';

import { providerErrorKey } from './provider-errors';

export const PRE_RESTORE_FILE = 'pre-restore.bgtb';
export const BACKUP_TYPE = 'application/octet-stream';

/** Maps backup errors to user messages; never shows internal details (A10, SEC-W09). */
export function restoreErrorKey(err: unknown): string {
  if (err instanceof ProviderError) return providerErrorKey(err);
  if (err instanceof UnsupportedVersionError) return 'backup.errors.newerVersion';
  if (err instanceof DecryptionError) return 'backup.errors.wrongPassphrase';
  if (err instanceof KdfPolicyError || err instanceof FormatError)
    return 'backup.errors.notABackup';
  if (err instanceof BackupPayloadError) return 'backup.errors.invalidContents';
  return 'app.genericError';
}

type RestoreStage =
  | { type: 'form' }
  | { type: 'confirm'; header: BackupHeader; payload: BackupPayload }
  | { type: 'done'; mode: RestoreMode; preRestore: Uint8Array | null };

/**
 * Passphrase + mode → decrypt and validate → confirm → pre-restore backup → restore (BUILD_PLAN
 * 2.3). Used for local files and cloud backups; `load` fetches the encrypted bytes.
 */
export function RestoreFlow({
  source,
  canOpen,
  load,
  onError,
  onCancel,
}: {
  /** Picks or describes the backup (file input, remote file name). */
  source: ReactNode;
  canOpen: boolean;
  load: () => Promise<Uint8Array>;
  /** Called with every failure (lets the caller react to e.g. an expired provider session). */
  onError?: (err: unknown) => void;
  /** Shows a Cancel button on the form stage. */
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const repos = useRepositories();
  const services = useServices();
  const queryClient = useQueryClient();
  const fmt = useFormatters();
  // Several flows can be on one page (file + cloud): each needs its own radio group.
  const modeGroup = useId();
  const [passphrase, setPassphrase] = useState('');
  const [mode, setMode] = useState<RestoreMode>('merge');
  const [stage, setStage] = useState<RestoreStage>({ type: 'form' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = (err: unknown) => {
    setError(t(restoreErrorKey(err)));
    onError?.(err);
  };

  const open = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canOpen) return;
    setBusy(true);
    setError(null);
    try {
      const { header, payload } = await readBackup(await load(), passphrase, {
        minKdf: services.kdfParams,
      });
      setStage({ type: 'confirm', header, payload });
    } catch (err) {
      fail(err);
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
    } catch (err) {
      // Restores run in one DB transaction: on failure nothing was changed.
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (stage.type === 'confirm') {
    return (
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
    );
  }

  if (stage.type === 'done') {
    return (
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
            if (onCancel) onCancel();
            else setStage({ type: 'form' });
          }}
        >
          {t(onCancel ? 'common.close' : 'backup.restoreAnother')}
        </Button>
      </div>
    );
  }

  return (
    <form className="grid gap-3" onSubmit={(e) => void open(e)} noValidate>
      {source}
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
              name={modeGroup}
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
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !canOpen || !passphrase}>
          <DatabaseBackup aria-hidden /> {busy ? t('backup.working') : t('backup.openBackup')}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}
