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

  it('offers no biometric unlock on the web or when it is turned off', async () => {
    renderApp({ unlocked: false });
    await screen.findByRole('heading', { name: 'Unlock Budget' });
    expect(screen.queryByRole('button', { name: /fingerprint/ })).not.toBeInTheDocument();
  });

  it('hides biometric unlock when it is on but the device has no biometrics now', async () => {
    const app = renderApp({ unlocked: false, biometrics: { enabled: true, available: false } });
    await screen.findByRole('heading', { name: 'Unlock Budget' });
    await vi.waitFor(() => {
      expect(app.services.vault.biometrics?.isAvailable).toHaveBeenCalled();
    });

    expect(screen.queryByRole('button', { name: /fingerprint/ })).not.toBeInTheDocument();
  });

  it('unlocks with biometrics and returns to the page that was open', async () => {
    const app = renderApp({ unlocked: false, route: '/settings', biometrics: { enabled: true } });

    await app.user.click(
      await screen.findByRole('button', { name: 'Unlock with fingerprint or face' }),
    );

    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    expect(app.services.vault.biometrics?.unlock).toHaveBeenCalledWith({
      title: 'Unlock Budget',
      cancel: 'Use passphrase',
    });
  });

  it('stays quiet when the prompt is cancelled', async () => {
    const app = renderApp({
      unlocked: false,
      biometrics: { enabled: true, result: { ok: false, error: 'CANCELLED' } },
    });

    await app.user.click(
      await screen.findByRole('button', { name: 'Unlock with fingerprint or face' }),
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Passphrase', { exact: true })).toBeInTheDocument();
  });

  it.each([
    ['LOCKED_OUT', 'Biometrics are blocked for now', true],
    ['FAILED', 'Biometric unlock did not work.', true],
    ['INVALIDATED', 'Biometric unlock was turned off', false],
  ] as const)('explains %s and falls back to the passphrase', async (error, text, stillOffered) => {
    const app = renderApp({
      unlocked: false,
      biometrics: { enabled: true, result: { ok: false, error } },
    });

    await app.user.click(
      await screen.findByRole('button', { name: 'Unlock with fingerprint or face' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByRole('button', { name: /fingerprint/ }) !== null).toBe(stillOffered);
  });

  it('has no axe violations with biometric unlock', async () => {
    const app = renderApp({ unlocked: false, biometrics: { enabled: true } });
    await screen.findByRole('button', { name: 'Unlock with fingerprint or face' });

    expect(await axe(app.container)).toHaveNoViolations();
  });
});
