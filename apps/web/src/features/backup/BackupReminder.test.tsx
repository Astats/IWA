import type { Repositories } from '@budget/core';
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REMINDER_CHECK_MS } from '@/hooks/useBackupReminder';
import { axe } from '@/test/axe';
import { createFakeServices, TEST_PASSPHRASE } from '@/test/fake-services';
import { renderApp } from '@/test/render';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-15T10:00:00.000Z');

async function seed(repos: Repositories) {
  await repos.categories.seedDefaults();
  const food = (await repos.categories.list()).find((c) => c.name === 'Food')!;
  await repos.transactions.create({
    kind: 'expense',
    amountMinor: 500,
    currency: 'EUR',
    categoryId: food.id,
    date: '2026-03-01',
    note: 'Lunch',
  });
}

/** Services whose clock follows the (fake) system time. */
function liveServices() {
  const services = createFakeServices();
  services.now = () => new Date();
  return services;
}

const banner = () => screen.queryByText(/You have no backup yet|A backup has been due since/);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  // Downloads go through a Blob URL; jsdom has none.
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('backup reminder banner', () => {
  it('stays hidden while there is no data', async () => {
    renderApp({ services: liveServices(), route: '/' });
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(banner()).toBeNull();
  });

  it('reminds when there is data but no backup, and links to the Backup screen', async () => {
    const services = liveServices();
    await seed(services.vault.repos);
    const app = renderApp({ services, route: '/' });

    expect(await screen.findByText(/You have no backup yet/)).toBeInTheDocument();
    await app.user.click(screen.getByRole('link', { name: 'Back up now' }));

    expect(await screen.findByRole('heading', { name: 'Backup', level: 1 })).toBeInTheDocument();
    // On the Backup screen itself the banner has no link.
    expect(screen.getByText(/You have no backup yet/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back up now' })).toBeNull();
  });

  it('is silent when reminders are off', async () => {
    const services = liveServices();
    await seed(services.vault.repos);
    await services.vault.repos.settings.set('backupFrequency', 'manual');
    renderApp({ services, route: '/' });
    await screen.findByRole('heading', { name: 'Dashboard' });
    await act(() => vi.advanceTimersByTimeAsync(30 * DAY));
    expect(banner()).toBeNull();
  });

  it('appears while the app is open once the weekly interval has passed', async () => {
    const services = liveServices();
    await seed(services.vault.repos);
    // 30 seconds short of a week (the app auto-locks long before a real week passes).
    await services.vault.repos.settings.set(
      'lastBackupAt',
      new Date(NOW.getTime() - 7 * DAY + 30_000).toISOString(),
    );
    renderApp({ services, route: '/' });
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(banner()).toBeNull();

    // The next minute tick re-evaluates the reminder.
    await act(() => vi.advanceTimersByTimeAsync(REMINDER_CHECK_MS));

    expect(await screen.findByText(/A backup has been due since/)).toBeInTheDocument();
  });

  it('a local backup download records the time and clears the reminder', async () => {
    const services = liveServices();
    await seed(services.vault.repos);
    const app = renderApp({ services, route: '/backup' });
    await screen.findByText(/You have no backup yet/);
    const status = screen
      .getByRole('heading', { name: 'Backup status' })
      .closest('[data-slot="card"]') as HTMLElement;
    expect(within(status).getByText('Never')).toBeInTheDocument();

    const download = screen
      .getByRole('heading', { name: 'Download an encrypted backup' })
      .closest('[data-slot="card"]') as HTMLElement;
    await app.user.type(within(download).getByLabelText('Current passphrase'), TEST_PASSPHRASE);
    await app.user.click(within(download).getByRole('button', { name: 'Download backup file' }));

    await screen.findByText('Backup downloaded.');
    const recorded = await services.vault.repos.settings.get('lastBackupAt');
    expect(Math.abs(Date.parse(recorded ?? '') - Date.now())).toBeLessThan(5000);
    expect(banner()).toBeNull();
    expect(within(status).queryByText('Never')).toBeNull();
    expect(within(status).getByText(/^Next reminder: /)).toBeInTheDocument();
  });

  it('the reminder frequency is saved in the vault', async () => {
    const services = liveServices();
    const app = renderApp({ services, route: '/backup' });

    await app.user.selectOptions(await screen.findByLabelText('Remind me to back up'), 'daily');

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(await services.vault.repos.settings.get('backupFrequency')).toBe('daily');
  });

  it('has no axe violations with the banner and status card', async () => {
    const services = liveServices();
    await seed(services.vault.repos);
    const app = renderApp({ services, route: '/backup' });
    await screen.findByText(/You have no backup yet/);
    await screen.findByLabelText('Remind me to back up');
    vi.useRealTimers();
    expect(await axe(app.container)).toHaveNoViolations();
  });
});
