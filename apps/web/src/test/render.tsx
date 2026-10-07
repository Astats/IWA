import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect } from 'vitest';

import { createQueryClient } from '@/app/App';
import { routes } from '@/app/router';
import { RepositoryProvider, type AppServices } from '@/di';

import { createFakeServices, type FakeVaultOptions } from './fake-services';

export interface RenderAppOptions extends FakeVaultOptions {
  route?: string;
  services?: ReturnType<typeof createFakeServices>;
  /** Pass to userEvent when fake timers are active. */
  advanceTimers?: (ms: number) => void;
}

export interface RenderAppResult extends RenderResult {
  services: ReturnType<typeof createFakeServices>;
  router: ReturnType<typeof createMemoryRouter>;
  queryClient: QueryClient;
  user: ReturnType<typeof userEvent.setup>;
}

/** Renders the full app (real routes and guards) over fake services and in-memory repositories. */
export function renderApp(options: RenderAppOptions = {}): RenderAppResult {
  const services = options.services ?? createFakeServices(options);
  const queryClient = createQueryClient();
  const router = createMemoryRouter(routes, { initialEntries: [options.route ?? '/'] });
  const user = userEvent.setup(
    options.advanceTimers ? { advanceTimers: options.advanceTimers } : {},
  );
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RepositoryProvider services={services as AppServices} onLock={() => queryClient.clear()}>
        <RouterProvider router={router} />
      </RepositoryProvider>
    </QueryClientProvider>,
  );
  return { ...result, services, router, queryClient, user };
}

/** Waits until the app has left the initial "Loading…" state. */
export async function waitForApp(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByText('Loading…')).toBeNull();
  });
}
