import { createCapacitorBiometricPort } from './capacitor-biometric';
import { createCapacitorSqlitePort } from './capacitor-sqlite';
import { NativeVault } from './native-vault';

export { NativeVault } from './native-vault';

/** The vault for the Android shell (loaded on demand: never part of the web bundle). */
export function createNativeVault(): NativeVault {
  return new NativeVault(createCapacitorSqlitePort(), {
    biometrics: createCapacitorBiometricPort(),
  });
}
