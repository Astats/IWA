import { useTranslation } from 'react-i18next';

import { PageHeader } from '@/components/layout/PageHeader';

/** Temporary page for routes whose feature lands in a later build step. */
export function PlaceholderPage({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return <PageHeader title={t(titleKey)} />;
}
