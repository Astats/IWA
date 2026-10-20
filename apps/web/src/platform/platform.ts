import type { DeepLinkHandler } from './deep-link';

export type PlatformId = 'web' | 'android';

export interface SaveFileRequest {
  name: string;
  content: string | Uint8Array;
  /** MIME type, e.g. `text/csv;charset=utf-8`. */
  type: string;
}

/** The system browser (Custom Tabs) for OAuth sign-in on Android. */
export interface AuthBrowser {
  open(url: string): Promise<void>;
  /** Android returns to the app on the redirect; closing is a no-op there. */
  close(): Promise<void>;
  /** `handler` runs when the browser is closed or the app is in the foreground again. */
  onClosed(handler: () => void): () => void;
}

/**
 * What differs between the browser and the Android shell (BUILD_PLAN 4.1, 4.3). UI code reaches
 * it through `useServices().platform` and never imports Capacitor directly.
 */
export interface PlatformService {
  readonly id: PlatformId;
  isNative(): boolean;
  /** Hands a file to the user: a download in the browser; the share sheet on native. */
  saveFile(file: SaveFileRequest): Promise<void>;
  /**
   * Handles app links for `path` (`com.astats.budget:/<path>`). Native only; on the web nothing
   * ever arrives. Returns a function that removes the handler.
   */
  onDeepLink(path: string, handler: DeepLinkHandler): () => void;
  /**
   * `handler` runs when the app must lock because it went to the background (native only,
   * SEC-M04). Trips started through `away` do not count unless they last too long.
   */
  onBackground(handler: () => void): () => void;
  /** Runs `task` while the user is sent out of the app (share sheet, file picker, sign-in). */
  away<T>(task: () => Promise<T>): Promise<T>;
  /** Android only: the system browser for OAuth sign-in. */
  readonly authBrowser?: AuthBrowser;
}
