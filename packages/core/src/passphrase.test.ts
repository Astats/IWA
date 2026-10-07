import { describe, expect, it } from 'vitest';

import { checkPassphrase, isCommonPassphrase, passphraseLength } from './passphrase';

describe('checkPassphrase', () => {
  it.each(['short', 'elevenchars', '', '😀😀😀😀😀😀😀😀😀😀😀'])(
    'rejects %j as too short',
    (p) => {
      const result = checkPassphrase(p);

      expect(result.ok).toBe(false);
      expect(result.issues).toContain('TOO_SHORT');
      expect(result.strength).toBe(0);
    },
  );

  it.each([
    'password1234',
    'Password1234',
    'QWERTY123456',
    'correct horse battery staple',
    'aaaaaaaaaaaaaaaa',
    'abcdefghijklmnopq',
    '123456789012',
  ])('rejects common passphrase %j', (p) => {
    const result = checkPassphrase(p);

    expect(result.issues).toContain('COMMON');
    expect(result.ok).toBe(false);
  });

  it.each([
    'tulip-river-quiet-lamp',
    'Mežs un jūra 2026!',
    '😀🐱🌲 moon over riga',
    'zīmulis ķirbis ēna',
  ])('accepts %j (including long Unicode passphrases)', (p) => {
    expect(checkPassphrase(p)).toMatchObject({ ok: true, issues: [] });
  });

  it('rejects absurdly long input', () => {
    expect(checkPassphrase('ab1-'.repeat(300)).issues).toContain('TOO_LONG');
  });

  it('counts code points, not UTF-16 units', () => {
    expect(passphraseLength('😀😀😀')).toBe(3);
  });

  it('rates longer, more varied passphrases as stronger', () => {
    const weak = checkPassphrase('abababababab1').strength;
    const strong = checkPassphrase('Tulip-River-Quiet-Lamp-42!').strength;

    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBe(4);
  });
});

describe('isCommonPassphrase', () => {
  it('ignores case and spaces', () => {
    expect(isCommonPassphrase('Pass Word 1234')).toBe(true);
    expect(isCommonPassphrase('a unique sentence of mine')).toBe(false);
  });
});
