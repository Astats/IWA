import { Download } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useRepositories, useServices } from '@/di';
import { useErrorMessage } from '@/hooks/useRepoMutation';

import { downloadTransactionsCsv } from './csv-export';

export function ImportExportPage() {
  const { t } = useTranslation();
  const repos = useRepositories();
  const services = useServices();
  const errorMessage = useErrorMessage();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const exportAll = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const count = await downloadTransactionsCsv(
        repos,
        repos.transactions.exportAll(),
        services.now(),
      );
      setStatus(t('importExport.exported', { count }));
    } catch (err) {
      setStatus(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t('importExport.title')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t('importExport.exportTitle')}</h2>
            </CardTitle>
            <CardDescription>{t('importExport.exportIntro')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Button
              type="button"
              className="justify-self-start"
              disabled={busy}
              onClick={() => void exportAll()}
            >
              <Download aria-hidden /> {t('importExport.exportAll')}
            </Button>
            {status && (
              <p role="status" className="text-sm text-muted-foreground">
                {status}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
