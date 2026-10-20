import type * as BiometricPlugin from '@capgo/capacitor-native-biometric';
import { describe, expect, it, vi } from 'vitest';

const plugin = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  isDataSaved: vi.fn(),
  setData: vi.fn((_: unknown) => Promise.resolve()),
  getSecureData: vi.fn(),
  deleteData: vi.fn((_: unknown) => Promise.resolve()),
}));

vi.mock('@capgo/capacitor-native-biometric', async (importOriginal) => ({
  ...(await importOriginal<typeof BiometricPlugin>()),
  NativeBiometric: plugin,
}));

const { BIOMETRIC_KEY, createCapacitorBiometricPort, toBiometricKeyError } =
  await import('./capacitor-biometric');

const prompt = { title: 'Unlock Budget', cancel: 'Use passphrase' };

describe('capacitor biometric port', () => {
  it('stores the value bound to the current biometrics, with a prompt for every read', async () => {
    await createCapacitorBiometricPort().store('ab'.repeat(32));

    expect(plugin.setData).toHaveBeenCalledWith({
      key: BIOMETRIC_KEY,
      value: 'ab'.repeat(32),
      accessControl: 1, // BIOMETRY_CURRENT_SET
      authValidityDuration: 0,
    });
  });

  it('reads through the biometric prompt without a device-passcode fallback', async () => {
    plugin.getSecureData.mockResolvedValueOnce({ value: 'secret' });

    expect(await createCapacitorBiometricPort().read(prompt)).toBe('secret');
    expect(plugin.getSecureData).toHaveBeenCalledWith(
      expect.objectContaining({
        key: BIOMETRIC_KEY,
        title: 'Unlock Budget',
        negativeButtonText: 'Use passphrase',
        fallbackTitle: '',
      }),
    );
  });

  it('needs strong biometrics to count as available', async () => {
    const port = createCapacitorBiometricPort();
    plugin.isAvailable.mockResolvedValueOnce({
      isAvailable: true,
      strongBiometryIsAvailable: false,
    });
    expect(await port.isAvailable()).toBe(false);
    plugin.isAvailable.mockResolvedValueOnce({
      isAvailable: true,
      strongBiometryIsAvailable: true,
    });
    expect(await port.isAvailable()).toBe(true);
    expect(plugin.isAvailable).toHaveBeenCalledWith({ useFallback: false });
  });

  it('maps a failed read to its reason', async () => {
    plugin.getSecureData.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '16' }));

    await expect(createCapacitorBiometricPort().read(prompt)).rejects.toMatchObject({
      reason: 'CANCELLED',
    });
  });

  it.each([
    ['16', 'CANCELLED'],
    ['17', 'CANCELLED'],
    ['15', 'CANCELLED'],
    ['11', 'CANCELLED'],
    ['2', 'LOCKED_OUT'],
    ['4', 'LOCKED_OUT'],
    ['10', 'FAILED'],
    ['21', 'MISSING'],
    ['0', 'INVALIDATED'],
    [undefined, 'INVALIDATED'],
  ])('error code %s → %s', (code, reason) => {
    expect(toBiometricKeyError({ code }).reason).toBe(reason);
  });
});
