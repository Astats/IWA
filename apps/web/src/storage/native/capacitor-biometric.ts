import {
  AccessControl,
  BiometricAuthError,
  NativeBiometric,
} from '@capgo/capacitor-native-biometric';

import { BiometricKeyError, type BiometricKeyPort } from './native-vault';

/** Storage key of the biometric-protected SQLCipher secret. */
export const BIOMETRIC_KEY = 'com.astats.budget.vault';

/** Plugin error codes (`BiometricAuthError`) → why the key could not be read. */
const REASONS = new Map<number, BiometricKeyError['reason']>([
  [BiometricAuthError.USER_CANCEL, 'CANCELLED'],
  [BiometricAuthError.USER_FALLBACK, 'CANCELLED'],
  [BiometricAuthError.SYSTEM_CANCEL, 'CANCELLED'],
  [BiometricAuthError.APP_CANCEL, 'CANCELLED'],
  [BiometricAuthError.USER_LOCKOUT, 'LOCKED_OUT'],
  [BiometricAuthError.USER_TEMPORARY_LOCKOUT, 'LOCKED_OUT'],
  [BiometricAuthError.AUTHENTICATION_FAILED, 'FAILED'],
  [BiometricAuthError.NO_PROTECTED_CREDENTIALS_FOUND, 'MISSING'],
]);

export function toBiometricKeyError(err: unknown): BiometricKeyError {
  const code = Number((err as { code?: unknown } | null)?.code);
  // Anything else: biometrics removed or changed (the key is invalidated), or the key is unusable.
  return new BiometricKeyError(REASONS.get(code) ?? 'INVALIDATED');
}

/**
 * `@capgo/capacitor-native-biometric` behind the vault's biometric port. Values are stored with
 * BIOMETRY_CURRENT_SET and no validity window: on Android an RSA Keystore key that needs a strong
 * biometric for every decryption (BiometricPrompt with a CryptoObject); on iOS a Keychain item
 * with biometric access control. Enrolling a new fingerprint or face invalidates it.
 */
export function createCapacitorBiometricPort(): BiometricKeyPort {
  return {
    async isAvailable() {
      const result = await NativeBiometric.isAvailable({ useFallback: false });
      return result.isAvailable && result.strongBiometryIsAvailable;
    },
    async isStored() {
      return (await NativeBiometric.isDataSaved({ key: BIOMETRIC_KEY })).isSaved;
    },
    store: (value) =>
      NativeBiometric.setData({
        key: BIOMETRIC_KEY,
        value,
        accessControl: AccessControl.BIOMETRY_CURRENT_SET,
        authValidityDuration: 0,
      }),
    async read(prompt) {
      try {
        const { value } = await NativeBiometric.getSecureData({
          key: BIOMETRIC_KEY,
          title: prompt.title,
          reason: prompt.title,
          negativeButtonText: prompt.cancel,
          fallbackTitle: '', // no device-passcode fallback: the passphrase is the fallback
          maxAttempts: 5,
        });
        return value;
      } catch (err) {
        throw toBiometricKeyError(err);
      }
    },
    remove: () => NativeBiometric.deleteData({ key: BIOMETRIC_KEY }),
  };
}
