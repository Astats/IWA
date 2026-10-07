import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createFakeServices } from '@/test/fake-services';
import { renderApp } from '@/test/render';

describe('route guards', () => {
  it('no vault → onboarding', async () => {
    const { router } = renderApp({ hasVault: false, unlocked: false, route: '/transactions' });

    expect(await screen.findByRole('heading', { name: 'Welcome to Budget' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/onboarding');
  });

  it('locked → unlock, remembering the requested path', async () => {
    const { router } = renderApp({ unlocked: false, route: '/settings' });

    expect(await screen.findByRole('heading', { name: 'Unlock Budget' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/unlock');
    expect(router.state.location.state).toEqual({ from: '/settings' });
  });

  it('unlocked → requested route', async () => {
    const { router } = renderApp({ route: '/settings' });

    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings');
  });

  it('unlocked users are sent away from onboarding and unlock', async () => {
    const { router } = renderApp({ route: '/unlock' });

    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('an unknown route inside the app shows a not-found page', async () => {
    renderApp({ route: '/nope' });

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute(
      'href',
      '/',
    );
  });

  it('shows a generic error when the storage worker is unavailable', async () => {
    const services = createFakeServices();
    services.vault.status = () => Promise.reject(new Error('worker failed'));

    renderApp({ services });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    );
  });
});
