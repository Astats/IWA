import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';

import { RepositoryProvider, type AppServices } from '@/di';

import { routes } from './router';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export function App({ services }: { services: AppServices }) {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(() => createBrowserRouter(routes));
  return (
    <QueryClientProvider client={queryClient}>
      {/* Locking clears every cached query so no financial data stays in memory (SEC-W08). */}
      <RepositoryProvider services={services} onLock={() => queryClient.clear()}>
        <RouterProvider router={router} />
      </RepositoryProvider>
    </QueryClientProvider>
  );
}
