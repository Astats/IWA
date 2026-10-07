import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** Page heading that also sets the document title. */
export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  const { t } = useTranslation();
  useEffect(() => {
    document.title = `${title} · ${t('app.name')}`;
  }, [title, t]);
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
