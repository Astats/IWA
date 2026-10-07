import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from '@/test/axe';

import { TEST_PASSPHRASE } from '@/test/fake-services';
import { renderApp } from '@/test/render';

import { defaultCurrencyFor } from './OnboardingPage';

async function toPassphraseStep() {
  const app = renderApp({ hasVault: false, unlocked: false });
  await app.user.click(await screen.findByRole('button', { name: 'Get started' }));
  return app;
}

async function fillPassphrase(
  app: Awaited<ReturnType<typeof toPassphraseStep>>,
  value: string,
  confirm = value,
) {
  const passphrase = screen.getByLabelText('Passphrase', { exact: true });
  const repeat = screen.getByLabelText('Repeat passphrase', { exact: true });
  await app.user.clear(passphrase);
  if (value) await app.user.type(passphrase, value);
  await app.user.clear(repeat);
  if (confirm) await app.user.type(repeat, confirm);
}

describe('OnboardingPage passphrase policy (SEC-W07)', () => {
  it('rejects passphrases shorter than 12 characters and focuses the field', async () => {
    const app = await toPassphraseStep();

    await fillPassphrase(app, 'elevenchars');
    await app.user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument();
    expect(screen.getByLabelText('Passphrase', { exact: true })).toHaveFocus();
    expect(screen.getByLabelText('Passphrase', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('rejects common passphrases', async () => {
    const app = await toPassphraseStep();

    await fillPassphrase(app, 'Password1234');
    await app.user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText(/This passphrase is too common/)).toBeInTheDocument();
  });

  it('requires the repeat to match and the data-loss acknowledgement', async () => {
    const app = await toPassphraseStep();

    await fillPassphrase(app, TEST_PASSPHRASE, `${TEST_PASSPHRASE}!`);
    await app.user.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('The passphrases do not match.')).toBeInTheDocument();
    expect(screen.getByText('Please confirm that you understand.')).toBeInTheDocument();
    expect(screen.getByText(/cannot be recovered/)).toBeInTheDocument();
  });

  it('accepts long Unicode passphrases and creates the vault with the chosen preferences', async () => {
    const app = await toPassphraseStep();
    const unicode = 'Mežs un jūra 🌲🌊 ķirbis ēna';

    await fillPassphrase(app, unicode);
    expect(screen.getByText(/Strength: (good|strong)/)).toBeInTheDocument();
    await app.user.click(screen.getByRole('checkbox', { name: /lost passphrase means lost data/ }));
    await app.user.click(screen.getByRole('button', { name: 'Next' }));
    await app.user.selectOptions(await screen.findByLabelText('Base currency'), 'JPY');
    await app.user.click(screen.getByRole('button', { name: 'Create my vault' }));

    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(app.services.vault.createVault).toHaveBeenCalledWith(unicode);
    expect(await app.services.vault.repos.settings.get('baseCurrency')).toBe('JPY');
    expect(await app.services.vault.repos.categories.list()).toHaveLength(13);
    expect(app.services.vault.flush).toHaveBeenCalled();
  });

  it('shows a generic error when vault creation fails', async () => {
    const app = await toPassphraseStep();
    app.services.vault.state.hasVault = true; // the fake now answers VAULT_EXISTS

    await fillPassphrase(app, TEST_PASSPHRASE);
    await app.user.click(screen.getByRole('checkbox', { name: /lost passphrase/ }));
    await app.user.click(screen.getByRole('button', { name: 'Next' }));
    await app.user.click(await screen.findByRole('button', { name: 'Create my vault' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The vault could not be created.');
  });

  it('can go back from preferences to the passphrase step', async () => {
    const app = await toPassphraseStep();
    await fillPassphrase(app, TEST_PASSPHRASE);
    await app.user.click(screen.getByRole('checkbox', { name: /lost passphrase/ }));
    await app.user.click(screen.getByRole('button', { name: 'Next' }));

    await app.user.click(await screen.findByRole('button', { name: 'Back' }));

    expect(screen.getByRole('heading', { name: 'Create a passphrase' })).toBeInTheDocument();
  });

  it('toggles passphrase visibility', async () => {
    const app = await toPassphraseStep();
    const input = screen.getByLabelText('Passphrase', { exact: true });

    await app.user.click(screen.getAllByRole('button', { name: 'Show passphrase' })[0]!);

    expect(input).toHaveAttribute('type', 'text');
    await app.user.click(screen.getByRole('button', { name: 'Hide passphrase' }));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('has no axe violations on each step', async () => {
    const app = renderApp({ hasVault: false, unlocked: false });
    await screen.findByRole('button', { name: 'Get started' });
    expect(await axe(app.container)).toHaveNoViolations();

    await app.user.click(screen.getByRole('button', { name: 'Get started' }));
    await app.user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument();
    });

    expect(await axe(app.container)).toHaveNoViolations();
  });
});

describe('defaultCurrencyFor', () => {
  it.each([
    ['en-US', 'USD'],
    ['en-GB', 'GBP'],
    ['ja-JP', 'JPY'],
    ['de-DE', 'EUR'],
    ['lv', 'EUR'],
  ])('%s → %s', (locale, currency) => {
    expect(defaultCurrencyFor(locale)).toBe(currency);
  });
});
