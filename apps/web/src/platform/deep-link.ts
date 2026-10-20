/**
 * The app's private URL scheme (reverse domain of the appId, RFC 8252 §7.1). Registered in
 * android/app/src/main/AndroidManifest.xml; a test keeps them in sync.
 */
export const APP_URL_SCHEME = 'com.astats.budget';

/** Longer links are dropped without parsing (OAuth callbacks are well below this). */
export const MAX_DEEP_LINK_LENGTH = 4096;

export interface DeepLink {
  /** Path with a leading slash, e.g. `/auth/callback/dropbox`. */
  path: string;
  params: URLSearchParams;
}

/**
 * Parses `com.astats.budget:/path?query` (or `com.astats.budget://path?query`). Any other scheme,
 * credentials, a port or an oversized link → null. The fragment is ignored.
 */
export function parseDeepLink(raw: string, scheme: string = APP_URL_SCHEME): DeepLink | null {
  if (raw.length > MAX_DEEP_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${scheme}:`) return null;
  if (url.username || url.password || url.port) return null;
  // `scheme://auth/callback` puts the first segment into the host; `scheme:/auth/callback` doesn't.
  const path = url.host ? `/${url.host}${url.pathname}` : url.pathname;
  return { path, params: url.searchParams };
}

export type DeepLinkHandler = (params: URLSearchParams) => void;

/**
 * Dispatches deep links to the handler registered for their exact path. Links for any other path
 * are dropped: a deep link never navigates the app or reaches code that did not ask for it.
 */
export class DeepLinkRouter {
  readonly #handlers = new Map<string, DeepLinkHandler>();

  constructor(private readonly scheme: string = APP_URL_SCHEME) {}

  /** One handler per path; returns a function that removes it. */
  on(path: string, handler: DeepLinkHandler): () => void {
    if (this.#handlers.has(path)) throw new Error(`A deep-link handler for ${path} already exists`);
    this.#handlers.set(path, handler);
    return () => {
      if (this.#handlers.get(path) === handler) this.#handlers.delete(path);
    };
  }

  /** Returns true when a handler took the link. */
  dispatch(raw: string): boolean {
    const link = parseDeepLink(raw, this.scheme);
    if (!link) return false;
    const handler = this.#handlers.get(link.path);
    if (!handler) return false;
    handler(link.params);
    return true;
  }
}
