import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { createBrowserServices } from './app/browser-services';
import { initI18n } from './i18n';
import { applyTheme } from './lib/theme';
import { readUiPrefs } from './lib/ui-prefs';
import './index.css';

const prefs = readUiPrefs();
applyTheme(prefs.theme);
initI18n(prefs.locale);

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');

createRoot(container).render(
  <StrictMode>
    <App services={createBrowserServices()} />
  </StrictMode>,
);
