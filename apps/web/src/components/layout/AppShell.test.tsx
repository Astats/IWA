import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeServices, TEST_PASSPHRASE } from '@/test/fake-services';
import { renderApp } from '@/test/render';

afterEach(() => {
  vi.useRealTimers();
});

describe('auto-lock (SEC-W08)', () => {
  it('locks after N minutes of inactivity, clears the query cache and the DOM', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const services = createFakeServices();
    await services.vault.repos.settings.set('baseCurrency', 'CHF');
    await services.vault.repos.settings.set('autoLockMinutes', 2);
    const app = renderApp({ services, route: '/settings', advanceTimers: vi.advanceTimersByTime });
    expect(await screen.findByDisplayValue(/CHF/)).toBeInTheDocument();
    expect(app.queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);

    await act(() => vi.advanceTimersByTimeAsync(2 * 60_000 + 100));

    expect(await screen.findByRole('heading', { name: 'Unlock Budget' })).toBeInTheDocument();
    expect(app.services.vault.lock).toHaveBeenCalled();
    expect(app.queryClient.getQueryCache().getAll()).toEqual([]);
    expect(document.body).not.toHaveTextContent('Swiss Franc');
  });

  it('user activity resets the timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = renderApp({ route: '/settings', advanceTimers: vi.advanceTimersByTime });
    await screen.findByRole('heading', { name: 'Settings', level: 1 });

    await act(() => vi.advanceTimersByTimeAsync(4 * 60_000));
    await app.user.keyboard('{Shift}');
    await act(() => vi.advanceTimersByTimeAsync(4 * 60_000));

    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    expect(app.services.vault.lock).not.toHaveBeenCalled();
  });

  it('the manual Lock button locks immediately', async () => {
    const app = renderApp({ route: '/settings' });
    await screen.findByRole('heading', { name: 'Settings', level: 1 });

    await app.user.click(screen.getAllByRole('button', { name: 'Lock' })[0]!);

    expect(await screen.findByRole('heading', { name: 'Unlock Budget' })).toBeInTheDocument();
    expect(app.services.vault.lock).toHaveBeenCalledTimes(1);
  });

  it('flushes pending writes when the page is hidden', async () => {
    const app = renderApp();
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
    const flushes = vi.mocked(app.services.vault.flush).mock.calls.length;

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(app.services.vault.flush).toHaveBeenCalledTimes(flushes + 1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('warns when persistent storage is denied', async () => {
    const app = renderApp({ persisted: false, unlocked: false });

    await app.user.type(
      await screen.findByLabelText('Passphrase', { exact: true }),
      TEST_PASSPHRASE,
    );
    await app.user.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByText(/Your browser may clear this app's data/)).toBeInTheDocument();
  });

  it('renders navigation for all sections', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });

    const navs = screen.getAllByRole('navigation', { name: 'Main' });
    for (const name of [
      'Dashboard',
      'Transactions',
      'Categories',
      'Import / Export',
      'Backup',
      'Settings',
    ]) {
      expect(navs[0]!).toContainElement(screen.getAllByRole('link', { name })[0]!);
    }
  });
});
