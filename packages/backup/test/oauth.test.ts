import { describe, expect, it } from 'vitest';

import { base64Url, createPkce, pkceChallenge, randomState } from '../src';

describe('PKCE (RFC 7636)', () => {
  it('matches the S256 test vector from RFC 7636 appendix B', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('creates fresh 43-char unreserved verifiers with matching challenges', async () => {
    const a = await createPkce();
    const b = await createPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toBe(await pkceChallenge(a.verifier));
  });

  it('base64url has no padding or URL-unsafe characters', () => {
    expect(base64Url(Uint8Array.of(0xfb, 0xff, 0xbf))).toBe('-_-_');
    expect(base64Url(Uint8Array.of(1))).toBe('AQ');
  });

  it('state values are random and URL-safe', () => {
    const states = new Set(Array.from({ length: 100 }, randomState));
    expect(states.size).toBe(100);
    for (const s of states) expect(s).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
