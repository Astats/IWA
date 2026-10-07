import type { Theme } from '@budget/core';

let mediaListener: (() => void) | null = null;

/** Applies light/dark/system by toggling the `dark` class on <html> (no inline styles; CSP). */
export function applyTheme(theme: Theme): void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const update = () => {
    const dark = theme === 'dark' || (theme === 'system' && media.matches);
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  };
  if (mediaListener) media.removeEventListener('change', mediaListener);
  mediaListener = theme === 'system' ? update : null;
  if (mediaListener) media.addEventListener('change', mediaListener);
  update();
}
