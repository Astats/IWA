import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { axe } from '@/test/axe';
import { TEST_PASSPHRASE } from '@/test/fake-services';
import { renderApp } from '@/test/render';

const card = async () =>
  (await screen.findByRole('heading', { name: 'Fingerprint or face unlock' })).closest(
    '[data-slot="card"]',
  ) as HTMLElement;

describe('BiometricSettings (BUILD_PLAN 4.3)', () => {
  it('is not shown on the web', async () => {
    renderApp({ route: '/settings' });
    await screen.findByRole('heading', { name: 'Settings', level: 1 });

    expect(screen.queryByText('Fingerprint or face unlock')).not.toBeInTheDocument();
  });

  it('is not shown on a device without strong biometrics', async () => {
    const app = renderApp({ route: '/settings', biometrics: { available: false } });
    await vi.waitFor(() => {
      expect(app.services.vault.biometrics?.isAvailable).toHaveBeenCalled();
    });

    expect(screen.queryByText('Fingerprint or face unlock')).not.toBeInTheDocument();
  });

  it('turns on only with the right passphrase, then off again', async () => {
    const app = renderApp({ route: '/settings', biometrics: {} });
    const section = await card();
    const input = within(section).getByLabelText('Current passphrase', { exact: true });
    expect(within(section).getByRole('status')).toHaveTextContent('Biometric unlock is off.');

    await app.user.type(input, 'wrong passphrase 1');
    await app.user.click(within(section).getByRole('button', { name: 'Turn on' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent('could not be turned on');
    expect(app.services.vault.state.biometricEnabled).toBe(false);

    await app.user.type(input, TEST_PASSPHRASE);
    await app.user.click(within(section).getByRole('button', { name: 'Turn on' }));
    expect(await within(section).findByText('Biometric unlock is on.')).toBeInTheDocument();
    expect(app.services.vault.state.biometricEnabled).toBe(true);

    await app.user.click(within(section).getByRole('button', { name: 'Turn off' }));
    expect(await within(section).findByText('Biometric unlock is off.')).toBeInTheDocument();
    expect(app.services.vault.biometrics?.disable).toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    const app = renderApp({ route: '/settings', biometrics: { enabled: true } });
    await within(await card()).findByRole('button', { name: 'Turn off' });

    expect(await axe(app.container)).toHaveNoViolations();
  });
});
