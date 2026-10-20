import { Capacitor } from '@capacitor/core';

import { createNativePlatform } from './native-platform';
import type { PlatformService } from './platform';
import { createWebPlatform } from './web-platform';

export * from './deep-link';
export * from './platform';
export { createWebPlatform } from './web-platform';

/** The platform the app runs on: the Capacitor shell (Android) or the browser. */
export function createPlatform(): PlatformService {
  const id = Capacitor.getPlatform();
  if (Capacitor.isNativePlatform() && id === 'android') {
    return createNativePlatform();
  }
  return createWebPlatform();
}
