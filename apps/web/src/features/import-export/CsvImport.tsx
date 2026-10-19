import {
  commitImport,
  exportErrorsCsv,
  loadImportContext,
  planImport,
  type CsvParseOutcome,
  type ImportContext,
  type ImportOptions,
  type ImportRowError,
} from '@budget/core/csv';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useRepositories, useServices } from '@/di';
import { useFormatters } from '@/hooks/useFormatters';
import { LEDGER_KEYS } from '@/hooks/useRepoMutation';
import { timestampedName } from '@/lib/download';

const PREVIEW_ROWS = 50;
const SHOWN_ERRORS = 100;

type Phase =
  | { type: 'idle' }
  | { type: 'parsing' }
  | { type: 'fatal'; message: string }
  | {
      type: 'preview';
      outcome: Extract<CsvParseOutcome, { ok: true }>;
      ctx: ImportContext;
      fileName: string;
    }
  | { type: 'importing' }
  | { type: 'done'; count: number };

export function CsvImport() {
  const { t } = useTranslation();
  const repos = useRepositories();
  const services = useServices();
  const queryClient = useQueryClient();
  const fmt = useFormatters();
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ type: 'idle' });
  const [options, setOptions] = useState<ImportOptions>({
    skipDuplicates: true,
    createCategories: false,
  });
  const [commitError, setCommitError] = useState(false);

  const preview = phase.type === 'preview' ? phase : null;
  const plan = useMemo(
    () => (preview ? planImport(preview.outcome.valid, preview.ctx, options) : null),
    [preview, options],
  );
  const errorText = (e: ImportRowError) =>
    t(`importExport.rowErrors.${e.code}`, { defaultValue: t('importExport.rowErrors.INVALID') });
  const fieldText = (field: string) => t(`importExport.columns.${field}`, { defaultValue: field });

  const startPreview = async () => {
    if (!file) return;
    setCommitError(false);
    setPhase({ type: 'parsing' });
    try {
      const outcome = await services.parseCsv(file);
      if (!outcome.ok) {
        setPhase({
          type: 'fatal',
          message: t(`importExport.fatal.${outcome.code}`, { detail: outcome.detail.join(', ') }),
        });
        return;
      }
      setPhase({
        type: 'preview',
        outcome,
        ctx: await loadImportContext(repos),
        fileName: file.name,
      });
    } catch {
      setPhase({ type: 'fatal', message: t('app.genericError') });
    }
  };

  const commit = async () => {
    if (!plan || plan.rows.length === 0) return;
    setCommitError(false);
    setPhase({ type: 'importing' });
    try {
      const count = await commitImport(repos, plan);
      await services.vault.flush();
      await Promise.all(LEDGER_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      setPhase({ type: 'done', count });
      setFile(null);
    } catch {
      // All or nothing: nothing was imported. Details stay out of the UI (A10).
      setCommitError(true);
      if (preview) setPhase(preview);
    }
  };

  const newCategoryNames = preview && plan ? missingNames(preview, plan, options) : [];
  const invalidRows = preview ? new Set(preview.outcome.errors.map((e) => e.row)).size : 0;
  const statusByRow = new Map<number, string>();
  if (plan && preview) {
    for (const r of plan.duplicates) statusByRow.set(r, t('importExport.status.duplicate'));
    for (const r of plan.missingCategoryRows)
      statusByRow.set(r, t('importExport.status.missingCategory'));
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>
          <h2>{t('importExport.importTitle')}</h2>
        </CardTitle>
        <CardDescription>{t('importExport.importIntro')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor={fileId}>{t('importExport.file')}</Label>
            <input
              id={fileId}
              type="file"
              accept=".csv,text/csv"
              className="text-sm file:mr-2 file:rounded-md file:border file:bg-transparent file:px-2 file:py-1"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPhase({ type: 'idle' });
              }}
            />
          </div>
          <Button
            type="button"
            disabled={!file || phase.type === 'parsing'}
            onClick={() => void startPreview()}
          >
            <Upload aria-hidden />{' '}
            {phase.type === 'parsing' ? t('importExport.reading') : t('importExport.preview')}
          </Button>
        </div>

        {phase.type === 'fatal' && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{phase.message}</AlertDescription>
          </Alert>
        )}
        {phase.type === 'done' && (
          <p role="status" className="text-sm">
            {t('importExport.imported', { count: phase.count })}
          </p>
        )}

        {preview && plan && (
          <section aria-label={t('importExport.previewTitle')} className="grid gap-4">
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              {[
                ['valid', preview.outcome.valid.length],
                ['invalid', invalidRows],
                ['duplicates', plan.duplicates.length],
                ['newCategories', newCategoryNames.length],
              ].map(([key, value]) => (
                <div key={key} className="rounded-md border p-2">
                  <dt className="text-muted-foreground">
                    {t(`importExport.counts.${String(key)}`)}
                  </dt>
                  <dd
                    className="text-lg font-semibold tabular-nums"
                    data-testid={`count-${String(key)}`}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>

            <fieldset className="grid gap-2 text-sm">
              <legend className="mb-1 font-medium">{t('importExport.options')}</legend>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={options.skipDuplicates}
                  onChange={(e) => {
                    setOptions((o) => ({ ...o, skipDuplicates: e.target.checked }));
                  }}
                />
                {t('importExport.skipDuplicates')}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={options.createCategories}
                  onChange={(e) => {
                    setOptions((o) => ({ ...o, createCategories: e.target.checked }));
                  }}
                />
                {t('importExport.createCategories', { names: newCategoryNames.join(', ') || '—' })}
              </label>
            </fieldset>

            {preview.outcome.errors.length > 0 && (
              <div className="grid gap-2">
                <h3 className="text-sm font-medium">
                  {t('importExport.errorsTitle', { count: preview.outcome.errors.length })}
                </h3>
                <ul
                  className="max-h-48 overflow-auto rounded-md border p-2 text-sm"
                  aria-label={t('importExport.errorsTitle', {
                    count: preview.outcome.errors.length,
                  })}
                >
                  {preview.outcome.errors.slice(0, SHOWN_ERRORS).map((e, i) => (
                    <li key={`${String(e.row)}-${e.field}-${String(i)}`}>
                      {t('importExport.errorLine', {
                        row: e.row,
                        field: fieldText(e.field),
                        message: errorText(e),
                      })}
                    </li>
                  ))}
                </ul>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="justify-self-start"
                  onClick={() => {
                    void services.platform.saveFile({
                      name: timestampedName('budget-import-errors', 'csv', services.now()),
                      content: exportErrorsCsv(
                        preview.outcome.errors.map((e) => ({
                          row: e.row,
                          field: e.field,
                          message: errorText(e),
                        })),
                      ),
                      type: 'text/csv;charset=utf-8',
                    });
                  }}
                >
                  <Download aria-hidden /> {t('importExport.downloadErrors')}
                </Button>
              </div>
            )}

            <div className="overflow-x-auto">
              <Table
                aria-label={t('importExport.previewTable', {
                  count: Math.min(PREVIEW_ROWS, preview.outcome.valid.length),
                })}
              >
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('importExport.columns.row')}</TableHead>
                    <TableHead>{t('transactions.date')}</TableHead>
                    <TableHead>{t('transactions.kind')}</TableHead>
                    <TableHead>{t('transactions.category')}</TableHead>
                    <TableHead>{t('transactions.note')}</TableHead>
                    <TableHead className="text-right">{t('transactions.amount')}</TableHead>
                    <TableHead>{t('importExport.columns.status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.outcome.valid.slice(0, PREVIEW_ROWS).map((r) => (
                    <TableRow key={r.row}>
                      <TableCell>{r.row}</TableCell>
                      <TableCell>{fmt.date(r.date)}</TableCell>
                      <TableCell>{t(`common.${r.kind}`)}</TableCell>
                      <TableCell>{r.categoryName}</TableCell>
                      <TableCell className="max-w-48 truncate">{r.note}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt.money(r.amountMinor, r.currency)}
                      </TableCell>
                      <TableCell>{statusByRow.get(r.row) ?? t('importExport.status.ok')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {commitError && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{t('importExport.commitFailed')}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={plan.rows.length === 0} onClick={() => void commit()}>
                {t('importExport.commit', { count: plan.rows.length })}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPhase({ type: 'idle' });
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </section>
        )}
        {phase.type === 'importing' && <p role="status">{t('importExport.importing')}</p>}
      </CardContent>
    </Card>
  );
}

/** Names of categories the file needs that do not exist yet. */
function missingNames(
  preview: { outcome: Extract<CsvParseOutcome, { ok: true }>; ctx: ImportContext },
  plan: ReturnType<typeof planImport>,
  options: ImportOptions,
): string[] {
  if (options.createCategories) return plan.newCategories.map((c) => c.name);
  const missing = new Set(plan.missingCategoryRows);
  return [
    ...new Set(preview.outcome.valid.filter((r) => missing.has(r.row)).map((r) => r.categoryName)),
  ];
}
