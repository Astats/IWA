import type { Repositories } from '@budget/core';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';

import type { AppServices } from './services';
import { createSessionStore, type SessionState, type SessionStore } from './session-store';

interface DiContextValue {
  services: AppServices;
  session: SessionStore;
}

const DiContext = createContext<DiContextValue | null>(null);

/**
 * Dependency-injection root (BUILD_PLAN 1.4). Builds the session store over the given services;
 * repositories come from the session once the vault is unlocked.
 */
export function RepositoryProvider({
  services,
  onLock,
  children,
}: {
  services: AppServices;
  onLock?: () => void;
  children: ReactNode;
}) {
  const [value] = useState<DiContextValue>(() => ({
    services,
    session: createSessionStore(services.vault, onLock),
  }));
  return <DiContext.Provider value={value}>{children}</DiContext.Provider>;
}

function useDi(): DiContextValue {
  const value = useContext(DiContext);
  if (!value) throw new Error('RepositoryProvider is missing');
  return value;
}

export function useSession<T>(selector: (state: SessionState) => T): T {
  return useStore(useDi().session, selector);
}

export function useSessionStore(): SessionStore {
  return useDi().session;
}

export function useServices(): AppServices {
  return useDi().services;
}

/** Repositories of the unlocked vault. Route guards ensure this is only used while unlocked. */
export function useRepositories(): Repositories {
  const repos = useSession((s) => s.repos);
  if (!repos) throw new Error('The vault is locked');
  return repos;
}
