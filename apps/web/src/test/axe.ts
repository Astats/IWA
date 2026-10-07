import { configureAxe } from 'vitest-axe';

/** axe for jsdom: color contrast needs real layout, so it is checked in the e2e axe runs instead. */
export const axe = configureAxe({ rules: { 'color-contrast': { enabled: false } } });
