/** Passphrase policy (BUILD_PLAN §6.2, ASVS V6): ≥ 12 characters, no composition rules, not common. */
export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 1024;

/**
 * Bundled list of common passwords that are at least 12 characters long (shorter ones already fail
 * the length rule). Compared case-insensitively after removing spaces.
 */
const COMMON_PASSPHRASES = new Set([
  '123456789012',
  '1234567890123',
  '12345678901234',
  '123456789123',
  '111111111111',
  '000000000000',
  '123123123123',
  '121212121212',
  '987654321098',
  'password1234',
  'password12345',
  'password123456',
  'passwordpassword',
  'password1password1',
  'mypassword123',
  'mypassword1234',
  'qwertyuiop12',
  'qwertyuiop123',
  'qwertyuiopasdf',
  'qwertyuiopasdfghjkl',
  'qwerty123456',
  'qwerty1234567',
  'qwertyqwerty',
  'qwertzuiop12',
  'azertyuiop12',
  'asdfghjkl123',
  'asdfghjkl1234',
  'zxcvbnm12345',
  '1q2w3e4r5t6y',
  '1qaz2wsx3edc',
  'qazwsxedcrfv',
  'iloveyou1234',
  'iloveyouiloveyou',
  'letmein12345',
  'welcome12345',
  'welcome123456',
  'trustno1trustno1',
  'abcdefghijkl',
  'abcdefghijklm',
  'abcdefghijklmnop',
  'abc123abc123',
  'abcd1234abcd',
  'football1234',
  'baseball1234',
  'superman1234',
  'monkey123456',
  'dragon123456',
  'sunshine1234',
  'princess1234',
  'starwars1234',
  'computer1234',
  'internet1234',
  'changeme1234',
  'administrator',
  'administrator1',
  'adminadmin123',
  'secretpassword',
  'correcthorsebatterystaple',
  'passw0rd1234',
  'p@ssw0rd1234',
  'p@ssword1234',
  'budgetbudget',
  'budget123456',
  'mybudget1234',
  'thisismypassword',
  'iamthebest123',
]);

export type PassphraseIssue = 'TOO_SHORT' | 'TOO_LONG' | 'COMMON';

export interface PassphraseCheck {
  ok: boolean;
  issues: PassphraseIssue[];
  /** 0 (very weak) … 4 (very strong); for the strength meter only. */
  strength: 0 | 1 | 2 | 3 | 4;
}

/** Length in Unicode code points (so emoji/diacritics count as one character each). */
export function passphraseLength(passphrase: string): number {
  return Array.from(passphrase).length;
}

function isTrivialPattern(p: string): boolean {
  const chars = Array.from(p);
  if (new Set(chars).size <= 2) return true;
  // Strictly ascending or descending code points (e.g. "abcdefghijkl", "987654321098").
  const steps = chars
    .slice(1)
    .map((c, i) => (c.codePointAt(0) ?? 0) - (chars[i]?.codePointAt(0) ?? 0));
  return steps.every((s) => s === 1) || steps.every((s) => s === -1);
}

export function isCommonPassphrase(passphrase: string): boolean {
  const normalized = passphrase.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  return COMMON_PASSPHRASES.has(normalized) || isTrivialPattern(normalized);
}

function estimateStrength(passphrase: string, common: boolean): PassphraseCheck['strength'] {
  if (common) return 0;
  const chars = Array.from(passphrase);
  let pool = 0;
  if (chars.some((c) => /[a-z]/.test(c))) pool += 26;
  if (chars.some((c) => /[A-Z]/.test(c))) pool += 26;
  if (chars.some((c) => /\d/.test(c))) pool += 10;
  if (chars.some((c) => /[^\p{L}\p{N}]/u.test(c))) pool += 33;
  if (chars.some((c) => /[^\p{ASCII}]/u.test(c))) pool += 100;
  const unique = new Set(chars).size;
  // Repetition lowers the effective length.
  const effectiveLength = Math.min(chars.length, unique * 2);
  const bits = effectiveLength * Math.log2(Math.max(pool, 2));
  if (bits < 40) return 1;
  if (bits < 60) return 2;
  if (bits < 80) return 3;
  return 4;
}

export function checkPassphrase(passphrase: string): PassphraseCheck {
  const length = passphraseLength(passphrase);
  const issues: PassphraseIssue[] = [];
  if (length < MIN_PASSPHRASE_LENGTH) issues.push('TOO_SHORT');
  if (length > MAX_PASSPHRASE_LENGTH) issues.push('TOO_LONG');
  const common = isCommonPassphrase(passphrase);
  if (common) issues.push('COMMON');
  const strength = issues.includes('TOO_SHORT') ? 0 : estimateStrength(passphrase, common);
  return { ok: issues.length === 0, issues, strength };
}
