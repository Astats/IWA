import type { DeepLinkHandler } from './deep-link';

export type PlatformId = 'web' | 'android' | 'ios';

export interface SaveFileRequest {
  name: string;
  content: string | Uint8Array;
  /** MIME type, e.g. `text/csv;charset=utf-8`. */
  type: string;
}

/** Thrown by operations the current platform does not offer (yet). */
export class PlatformUnsupportedError extends Error {
  constructor(operation: string, platform: PlatformId) {
    super(`${operation} is not supported on ${platform}`);
    this.name = 'PlatformUnsupportedError';
  }
}

/**
 * What differs between the browser and the native shells (BUILD_PLAN 4.1). UI code reaches it
 * through `useServices().platform` and never imports Capacitor directly.
 */
export interface PlatformService {
  readonly id: PlatformId;
  isNative(): boolean;
  /** Hands a file to the user: a download in the browser; the share sheet on native (Step 4.3). */
  saveFile(file: SaveFileRequest): Promise<void>;
  /**
   * Handles app links for `path` (`com.astats.budget:/<path>`). Native only; on the web nothing
   * ever arrives. Returns a function that removes the handler.
   */
  onDeepLink(path: string, handler: DeepLinkHandler): () => void;
}
