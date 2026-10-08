import { useRegisterSW } from 'virtual:pwa-register/react';

import { UpdatePrompt } from './UpdatePrompt';

/**
 * Registers the service worker (precached app shell, no runtime caching) and shows the update
 * prompt when a new version is waiting. Only used by the production entry (main.tsx).
 */
export function PwaUpdater() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  return (
    <UpdatePrompt
      visible={needRefresh}
      onReload={() => {
        void updateServiceWorker(true);
      }}
      onDismiss={() => {
        setNeedRefresh(false);
      }}
    />
  );
}
