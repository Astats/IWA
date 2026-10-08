import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

/** "New version available — reload" banner (BUILD_PLAN 1.10). Pure; wired up by PwaUpdater. */
export function UpdatePrompt({
  visible,
  onReload,
  onDismiss,
}: {
  visible: boolean;
  onReload: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-50 mx-auto flex max-w-md items-center gap-3 rounded-b-lg border bg-popover px-4 py-2 text-sm text-popover-foreground shadow-lg"
    >
      <span className="flex-1">{t('app.updateAvailable')}</span>
      <Button type="button" size="sm" onClick={onReload}>
        <RefreshCw aria-hidden /> {t('app.reload')}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
        {t('app.dismiss')}
      </Button>
    </div>
  );
}
