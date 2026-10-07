import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from '@/test/axe';

import { TEST_PASSPHRASE } from '@/test/fake-services';
import { renderApp } from '@/test/render';

afterEach(() => {
  vi.useRealTimers();
});

describe('UnlockPage', () => {
  it('wrong passphrase → generic error, progressive delay, then unlock (SEC-W06)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-03-15T10:00:00Z') });
    const app = renderApp({
      unlocked: false,
      route: '/settings',
      advanceTimers: vi.advanceTimersByTime,
    });
    const input = await screen.findByLabelText('Passphrase', { exact: true });

    await app.user.type(input, 'wrong passphrase');
    await app.user.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unlock failed. Check your passphrase and try again.',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Too many attempts. Try again in 1 s.');
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    await app.user.type(input, TEST_PASSPHRASE);
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeDisabled();

    await act(() => vi.advanceTimersByTimeAsync(1200));
    await app.user.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    expect(app.router.state.location.pathname).toBe('/settings');
  });

  it('the delay grows after repeated failures', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = renderApp({ unlocked: false, advanceTimers: vi.advanceTimersByTime });
    const input = await screen.findByLabelText('Passphrase', { exact: true });

    await app.user.type(input, 'wrong one');
    await app.user.click(screen.getByRole('button', { name: 'Unlock' }));
    await act(() => vi.advanceTimersByTimeAsync(1500));
    await app.user.type(input, 'wrong two');
    await app.user.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Try again in 2 s.');
  });

  it.each([
    ['CORRUPT', 'Your stored data could not be read.'],
    ['UNSUPPORTED_VERSION', 'created by a newer version'],
  ] as const)('shows a specific message for %s', async (error, text) => {
    const app = renderApp({ unlocked: false });
    app.services.vault.unlock = () => Promise.resolve({ ok: false, error });

    await app.user.type(
      await screen.findByLabelText('Passphrase', { exact: true }),
      'anything at all',
    );
    await app.user.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('has no axe violations', async () => {
    const app = renderApp({ unlocked: false });
    await screen.findByRole('heading', { name: 'Unlock Budget' });

    expect(await axe(app.container)).toHaveNoViolations();
  });
});
