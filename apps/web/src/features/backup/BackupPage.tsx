import { backupFileName, createBackup } from '@budget/backup';
import { Download } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Field } from '@/components/form/Field';
import { PassphraseInput } from '@/components/form/PassphraseInput';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useRepositories, useServices } from '@/di';
import { downloadFile } from '@/lib/download';

import { CloudBackup } from './CloudBackup';
import { BACKUP_TYPE, RestoreFlow } from './RestoreFlow';

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

function RestoreFromFile() {
  const { t } = useTranslation();
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t('backup.restoreTitle')}</h2>
        </CardTitle>
        <CardDescription>{t('backup.restoreIntro')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <RestoreFlow
          canOpen={file !== null}
          load={async () => {
            if (!file) throw new Error('No file selected');
            return new Uint8Array(await file.arrayBuffer());
          }}
          source={
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
          }
        />
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
        <CloudBackup />
        <DownloadBackup />
        <RestoreFromFile />
      </div>
    </>
  );
}
