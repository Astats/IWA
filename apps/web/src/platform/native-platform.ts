import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

import { bytesToBase64 } from '@/lib/base64';

import { BackgroundLock } from './background-lock';
import { DeepLinkRouter } from './deep-link';
import type { AuthBrowser, PlatformService, SaveFileRequest } from './platform';

/** Files handed to the share sheet; cache only, cleared on launch, before each export and on lock. */
export const EXPORT_DIR = 'exports';

/** Keeps a file name to letters, digits, `.`, `_` and `-` (it becomes part of a path). */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^\w.-]/g, '_').replace(/^\.+/, '_');
  return cleaned.slice(0, 120) || 'export';
}

function clearExports(): Promise<void> {
  return Filesystem.rmdir({ path: EXPORT_DIR, directory: Directory.Cache, recursive: true }).catch(
    () => undefined, // nothing to clear
  );
}

/** Writes the file to the cache and opens the share sheet; cancelling the sheet is not an error. */
async function shareFile({ name, content }: SaveFileRequest): Promise<void> {
  await clearExports();
  const { uri } = await Filesystem.writeFile({
    path: `${EXPORT_DIR}/${safeFileName(name)}`,
    directory: Directory.Cache,
    recursive: true,
    ...(typeof content === 'string'
      ? { data: content, encoding: Encoding.UTF8 }
      : { data: bytesToBase64(content) }),
  });
  try {
    await Share.share({ title: name, files: [uri] });
  } catch (err) {
    if (err instanceof Error && /cancel/i.test(err.message)) return;
    throw err;
  }
}

const authBrowser: AuthBrowser = {
  open: (url) => Browser.open({ url }),
  close: () => Browser.close().catch(() => undefined), // Android: nothing to close
  // Android does not report every way out of the browser (e.g. Chrome's first-run screen is not a
  // Custom Tab), so returning to the app counts as closing it too; a redirect that brings the
  // app back still wins within the sign-in's grace period.
  onClosed(handler) {
    const listeners = [
      Browser.addListener('browserFinished', handler),
      App.addListener('resume', handler),
    ];
    return () => {
      for (const listener of listeners) void listener.then((l) => l.remove());
    };
  },
};

/**
 * The Capacitor shells. App links arrive through `appUrlOpen` and go to the deep-link router;
 * links that arrive while no handler waits for them (e.g. a cold start) are dropped. Going to
 * the background locks the app (BUILD_PLAN 4.3) and deletes shared export files.
 */
export function createNativePlatform(id: 'android' | 'ios'): PlatformService {
  const router = new DeepLinkRouter();
  const background = new BackgroundLock();
  void App.addListener('appUrlOpen', ({ url }) => {
    router.dispatch(url);
  });
  void App.addListener('pause', () => {
    background.paused();
  });
  void App.addListener('resume', () => {
    background.resumed();
  });
  background.onLock(() => void clearExports());
  void clearExports(); // left over from a previous run

  return {
    id,
    isNative: () => true,
    saveFile: (file) => background.away(() => shareFile(file)),
    onDeepLink: (path, handler, scheme) => router.on(path, handler, scheme),
    onBackground: (handler) => background.onLock(handler),
    away: (task) => background.away(task),
    authBrowser,
  };
}
