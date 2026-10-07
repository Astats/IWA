import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, Outlet, useLocation, type RouteObject } from 'react-router';

import { AppShell } from '@/components/layout/AppShell';
import { useSession, type SessionStatus } from '@/di';
import { CategoriesPage } from '@/features/categories/CategoriesPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { OnboardingPage } from '@/features/onboarding/OnboardingPage';
import { PlaceholderPage } from '@/features/placeholder/PlaceholderPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { TransactionEditorPage } from '@/features/transactions/TransactionEditorPage';
import { TransactionsPage } from '@/features/transactions/TransactionsPage';
import { UnlockPage } from '@/features/unlock/UnlockPage';

function FullScreenMessage({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center p-4 text-center">
      {children}
    </main>
  );
}

/** Loads the vault state once, then renders the matched route. */
function SessionGate() {
  const { t } = useTranslation();
  const status = useSession((s) => s.status);
  const refresh = useSession((s) => s.refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (status === 'checking') {
    return (
      <FullScreenMessage>
        <p role="status">{t('app.loading')}</p>
      </FullScreenMessage>
    );
  }
  if (status === 'error') {
    return (
      <FullScreenMessage>
        <p role="alert">{t('app.genericError')}</p>
      </FullScreenMessage>
    );
  }
  return <Outlet />;
}

const HOME_FOR_STATUS: Record<Exclude<SessionStatus, 'checking' | 'error'>, string> = {
  'no-vault': '/onboarding',
  locked: '/unlock',
  unlocked: '/',
};

/** Route guard: no vault → onboarding; locked → unlock; unlocked → requested route. */
export function RequireStatus({
  status,
  children,
}: {
  status: SessionStatus;
  children: ReactNode;
}) {
  const current = useSession((s) => s.status);
  const location = useLocation();
  if (current === status) return children;
  if (current === 'checking' || current === 'error') return null;
  const target = HOME_FOR_STATUS[current];
  // Remember where the user wanted to go so unlock can return there. Query strings only hold
  // non-sensitive list filters (never search terms, notes or amounts; SEC-W04).
  const state =
    current === 'locked' && status === 'unlocked'
      ? { from: location.pathname + location.search }
      : undefined;
  return <Navigate to={target} replace state={state} />;
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2">
      <h1 className="text-2xl font-semibold">{t('app.notFound')}</h1>
      <Link className="underline" to="/">
        {t('app.backHome')}
      </Link>
    </div>
  );
}

function RouteError() {
  const { t } = useTranslation();
  return (
    <FullScreenMessage>
      <p role="alert">{t('app.genericError')}</p>
    </FullScreenMessage>
  );
}

export const routes: RouteObject[] = [
  {
    element: <SessionGate />,
    errorElement: <RouteError />,
    children: [
      {
        path: 'onboarding',
        element: (
          <RequireStatus status="no-vault">
            <OnboardingPage />
          </RequireStatus>
        ),
      },
      {
        path: 'unlock',
        element: (
          <RequireStatus status="locked">
            <UnlockPage />
          </RequireStatus>
        ),
      },
      {
        element: (
          <RequireStatus status="unlocked">
            <AppShell />
          </RequireStatus>
        ),
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'transactions', element: <TransactionsPage /> },
          { path: 'transactions/new', element: <TransactionEditorPage /> },
          { path: 'transactions/:id', element: <TransactionEditorPage /> },
          { path: 'categories', element: <CategoriesPage /> },
          { path: 'import-export', element: <PlaceholderPage titleKey="importExport.title" /> },
          { path: 'backup', element: <PlaceholderPage titleKey="backup.title" /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
];
