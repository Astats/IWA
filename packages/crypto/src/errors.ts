/**
 * Decryption or authentication failed: wrong passphrase/key, or tampered/corrupted data.
 * Deliberately carries no detail that could help an attacker; never returns partial plaintext.
 */
export class DecryptionError extends Error {
  override readonly name = 'DecryptionError';

  constructor() {
    super('Decryption failed');
  }
}

/** Input is not a well-formed file of the expected format (bad magic, truncated, bad header). */
export class FormatError extends Error {
  override readonly name: string = 'FormatError';

  constructor(message = 'Invalid file format') {
    super(message);
  }
}

/** The file was written by a newer app (format version not supported yet). */
export class UnsupportedVersionError extends FormatError {
  override readonly name = 'UnsupportedVersionError';

  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`Unsupported format version ${found} (this app supports up to ${supported})`);
  }
}

/** The header asks for key-derivation parameters below the allowed minimum (downgrade attack). */
export class KdfPolicyError extends FormatError {
  override readonly name = 'KdfPolicyError';

  constructor() {
    super('Key-derivation parameters are below the allowed minimum');
  }
}

/** No vault exists in the given storage. */
export class VaultNotFoundError extends Error {
  override readonly name = 'VaultNotFoundError';

  constructor() {
    super('No vault found');
  }
}
