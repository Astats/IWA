/**
 * The app's private URL scheme (reverse domain of the appId, RFC 8252 §7.1). Registered in
 * android/app/src/main/AndroidManifest.xml and ios/App/App/Info.plist; a test keeps them in sync.
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
 * Dispatches deep links to the handler registered for their exact scheme and path. Links for any
 * other path are dropped: a deep link never navigates the app or reaches code that did not ask for
 * it. Handlers use the app's scheme unless they name another one (Google's iOS sign-in returns on
 * the reversed client id).
 */
export class DeepLinkRouter {
  readonly #handlers = new Map<string, DeepLinkHandler>();

  constructor(private readonly scheme: string = APP_URL_SCHEME) {}

  /** One handler per scheme and path; returns a function that removes it. */
  on(path: string, handler: DeepLinkHandler, scheme: string = this.scheme): () => void {
    const key = `${scheme.toLowerCase()}:${path}`;
    if (this.#handlers.has(key)) throw new Error(`A deep-link handler for ${key} already exists`);
    this.#handlers.set(key, handler);
    return () => {
      if (this.#handlers.get(key) === handler) this.#handlers.delete(key);
    };
  }

  /** Returns true when a handler took the link. */
  dispatch(raw: string): boolean {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
    if (!scheme) return false;
    const link = parseDeepLink(raw, scheme);
    if (!link) return false;
    const handler = this.#handlers.get(`${scheme}:${link.path}`);
    if (!handler) return false;
    handler(link.params);
    return true;
  }
}
