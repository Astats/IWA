import {
  ArrowLeftRight,
  DatabaseBackup,
  FileSpreadsheet,
  LayoutDashboard,
  Lock,
  Settings as SettingsIcon,
  Tags,
  type LucideIcon,
} from 'lucide-react';
import { Suspense, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';

import { ToastProvider } from '@/components/toast/Toaster';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useServices, useSession } from '@/di';
import { useAutoLock } from '@/hooks/useAutoLock';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useSettings } from '@/hooks/useSettings';
import { changeLocale, i18n } from '@/i18n';
import { applyTheme } from '@/lib/theme';
import { writeUiPrefs } from '@/lib/ui-prefs';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  labelKey: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', labelKey: 'nav.dashboard', icon: LayoutDashboard },
  { to: '/transactions', labelKey: 'nav.transactions', icon: ArrowLeftRight },
  { to: '/categories', labelKey: 'nav.categories', icon: Tags },
  { to: '/import-export', labelKey: 'nav.importExport', icon: FileSpreadsheet },
  { to: '/backup', labelKey: 'nav.backup', icon: DatabaseBackup },
  { to: '/settings', labelKey: 'nav.settings', icon: SettingsIcon },
];

/** Keeps theme and language in sync with the vault settings (the source of truth when unlocked). */
function useSettingsSync() {
  const { data: settings } = useSettings();
  useEffect(() => {
    if (!settings) return;
    applyTheme(settings.theme);
    if (i18n.language !== settings.locale) changeLocale(settings.locale);
    writeUiPrefs({ theme: settings.theme, locale: settings.locale });
  }, [settings]);
  return settings;
}

export function AppShell() {
  const { t } = useTranslation();
  const lock = useSession((s) => s.lock);
  const storagePersisted = useSession((s) => s.storagePersisted);
  const { vault } = useServices();
  const settings = useSettingsSync();
  // One navigation in the DOM at a time: sidebar on large screens, bottom bar on small ones.
  const desktop = useMediaQuery('(min-width: 64rem)');

  const onLock = useCallback(() => {
    void lock();
  }, [lock]);
  useAutoLock(settings?.autoLockMinutes, onLock);

  // Persist pending changes as soon as the page is hidden (tab switch, app backgrounded).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void vault.flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [vault]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded bg-background p-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        {t('app.skipToContent')}
      </a>
      {desktop && (
        <aside className="flex flex-col border-r bg-sidebar">
          <div className="p-4 text-lg font-semibold">{t('app.name')}</div>
          <nav aria-label={t('nav.main')} className="flex flex-1 flex-col gap-1 px-2">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-sidebar-accent',
                    isActive && 'bg-sidebar-accent font-medium',
                  )
                }
              >
                <item.icon aria-hidden className="size-4" />
                {t(item.labelKey)}
              </NavLink>
            ))}
          </nav>
          <div className="p-2">
            <Button type="button" variant="outline" className="w-full" onClick={onLock}>
              <Lock aria-hidden /> {t('nav.lock')}
            </Button>
          </div>
        </aside>
      )}

      <div className={cn('flex min-h-dvh flex-col', !desktop && 'pb-16')}>
        {!desktop && (
          <header className="flex items-center justify-between border-b px-4 py-2">
            <span className="font-semibold">{t('app.name')}</span>
            <Button type="button" variant="ghost" size="sm" onClick={onLock}>
              <Lock aria-hidden /> {t('nav.lock')}
            </Button>
          </header>
        )}
        {storagePersisted === false && (
          <Alert className="m-4 mb-0 w-auto" role="status">
            <AlertDescription>{t('app.storageWarning')}</AlertDescription>
          </Alert>
        )}
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 p-4 outline-none">
          <ToastProvider>
            <Suspense fallback={<p role="status">{t('app.loading')}</p>}>
              <Outlet />
            </Suspense>
          </ToastProvider>
        </main>
      </div>

      {!desktop && (
        <nav
          aria-label={t('nav.main')}
          className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t bg-background"
        >
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex min-w-0 flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[10px] text-muted-foreground',
                  isActive && 'font-medium text-foreground',
                )
              }
            >
              <item.icon aria-hidden className="size-5" />
              <span className="truncate">{t(item.labelKey)}</span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
