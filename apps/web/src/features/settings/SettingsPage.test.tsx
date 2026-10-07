import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from '@/test/axe';

import { TEST_PASSPHRASE } from '@/test/fake-services';
import { renderApp } from '@/test/render';

describe('SettingsPage', () => {
  it('saves preferences durably and applies the theme', async () => {
    const app = renderApp({ route: '/settings' });
    const currency = await screen.findByLabelText('Base currency');

    await app.user.selectOptions(currency, 'USD');
    await app.user.selectOptions(screen.getByLabelText('Theme'), 'dark');
    await app.user.clear(screen.getByLabelText('Auto-lock after (minutes)'));
    await app.user.type(screen.getByLabelText('Auto-lock after (minutes)'), '10');
    await app.user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(await app.services.vault.repos.settings.getAll()).toMatchObject({
      baseCurrency: 'USD',
      theme: 'dark',
      autoLockMinutes: 10,
    });
    expect(app.services.vault.flush).toHaveBeenCalled();
    expect(document.documentElement).toHaveClass('dark');
    expect(JSON.parse(localStorage.getItem('budget.ui-prefs') ?? '{}')).toEqual({
      theme: 'dark',
      locale: 'en',
    });
  });

  it('rejects an out-of-range auto-lock value', async () => {
    const app = renderApp({ route: '/settings' });
    const field = await screen.findByLabelText('Auto-lock after (minutes)');

    await app.user.clear(field);
    await app.user.type(field, '0');
    await app.user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('This value is not valid.')).toBeInTheDocument();
    expect(await app.services.vault.repos.settings.get('autoLockMinutes')).toBe(5);
  });

  it('changes the passphrase only with the correct current passphrase', async () => {
    const app = renderApp({ route: '/settings' });
    const next = 'another long passphrase 99';
    await screen.findByLabelText('Current passphrase');

    await app.user.type(screen.getByLabelText('Current passphrase'), 'wrong passphrase');
    await app.user.type(screen.getByLabelText('New passphrase', { exact: true }), next);
    await app.user.type(screen.getByLabelText('Repeat passphrase', { exact: true }), next);
    await app.user.click(screen.getByRole('button', { name: 'Change passphrase' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be changed');

    await app.user.clear(screen.getByLabelText('Current passphrase'));
    await app.user.type(screen.getByLabelText('Current passphrase'), TEST_PASSPHRASE);
    await app.user.click(screen.getByRole('button', { name: 'Change passphrase' }));

    expect(await screen.findByText('Passphrase changed.')).toBeInTheDocument();
    expect(app.services.vault.state.passphrase).toBe(next);
  });

  it('validates the new passphrase policy', async () => {
    const app = renderApp({ route: '/settings' });
    await screen.findByLabelText('Current passphrase');

    await app.user.click(screen.getByRole('button', { name: 'Change passphrase' }));

    expect(await screen.findByText('This field is required.')).toBeInTheDocument();
    expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument();
    expect(app.services.vault.changePassphrase).not.toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    const app = renderApp({ route: '/settings' });
    await screen.findByLabelText('Base currency');

    expect(await axe(app.container)).toHaveNoViolations();
  });
});
