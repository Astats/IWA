import { downloadFile } from '@/lib/download';

import type { PlatformService } from './platform';

/** The browser/PWA: files are downloads; there are no app links and no background lock. */
export function createWebPlatform(): PlatformService {
  return {
    id: 'web',
    isNative: () => false,
    saveFile({ name, content, type }) {
      downloadFile(name, content, type);
      return Promise.resolve();
    },
    onDeepLink: () => () => undefined,
    onBackground: () => () => undefined,
    away: (task) => task(),
  };
}
