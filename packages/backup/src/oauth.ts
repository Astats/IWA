/*
 * OAuth 2.0 helpers for public clients (RFC 7636 PKCE, RFC 6749 state). Pure Web Crypto; no
 * secrets. Used by the Dropbox sign-in (BUILD_PLAN 3.4); MSAL implements the same for Microsoft.
 */

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** S256 code challenge for a verifier: BASE64URL(SHA-256(ASCII(verifier))). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** 32 random bytes → 43-character verifier (RFC 7636 §4.1 recommends exactly this). */
export async function createPkce(): Promise<PkcePair> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await pkceChallenge(verifier) };
}

/** Unguessable `state` that ties a redirect to the sign-in that started it (CSRF protection). */
export function randomState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}
