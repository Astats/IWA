import { App } from '@capacitor/app';

import { DeepLinkRouter } from './deep-link';
import { PlatformUnsupportedError, type PlatformService } from './platform';

/**
 * The Capacitor shells. App links arrive through `appUrlOpen` and go to the deep-link router;
 * links that arrive while no handler waits for them (e.g. a cold start) are dropped.
 */
export function createNativePlatform(id: 'android' | 'ios'): PlatformService {
  const router = new DeepLinkRouter();
  void App.addListener('appUrlOpen', ({ url }) => {
    router.dispatch(url);
  });
  return {
    id,
    isNative: () => true,
    // Filesystem + share sheet arrive in Step 4.3 (BUILD_PLAN); a Blob download does nothing here.
    saveFile: () => Promise.reject(new PlatformUnsupportedError('saveFile', id)),
    onDeepLink: (path, handler) => router.on(path, handler),
  };
}
