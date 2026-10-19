import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { createBrowserServices } from './app/browser-services';
import { PwaUpdater } from './app/PwaUpdater';
import { initI18n } from './i18n';
import { applyTheme } from './lib/theme';
import { readUiPrefs } from './lib/ui-prefs';
import { createPlatform } from './platform';
import './index.css';

const prefs = readUiPrefs();
applyTheme(prefs.theme);
initI18n(prefs.locale);

// e2e builds only (vite --mode e2e): a fake cloud provider. The branch is removed from production
// builds, and scripts/verify-build.mjs proves the hook module is absent (SEC-W14).
const extraProviders =
  import.meta.env.MODE === 'e2e' ? (await import('./app/e2e-hooks')).installE2eHooks() : [];

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');

const platform = createPlatform();

createRoot(container).render(
  <StrictMode>
    <App
      services={createBrowserServices(platform, extraProviders)}
      // Native builds update through the app stores; a service worker would only serve stale shells.
      pwa={platform.isNative() ? undefined : <PwaUpdater />}
    />
  </StrictMode>,
);
