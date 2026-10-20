import { describe, expect, it, vi } from 'vitest';

import { createFakeVault, TEST_PASSPHRASE } from '@/test/fake-services';

import { createSessionStore } from './session-store';

describe('session store', () => {
  it.each([
    [{ hasVault: false, unlocked: false }, 'no-vault'],
    [{ hasVault: true, unlocked: false }, 'locked'],
    [{ hasVault: true, unlocked: true }, 'unlocked'],
  ] as const)('refresh maps %j to %s', async (options, status) => {
    const store = createSessionStore(createFakeVault(options));

    await store.getState().refresh();

    expect(store.getState().status).toBe(status);
    expect(store.getState().repos === null).toBe(status !== 'unlocked');
  });

  it('createVault seeds categories, stores preferences and unlocks', async () => {
    const vault = createFakeVault({ hasVault: false, unlocked: false });
    const store = createSessionStore(vault);

    const result = await store
      .getState()
      .createVault(TEST_PASSPHRASE, { baseCurrency: 'USD', locale: 'en-GB' });

    expect(result).toEqual({ ok: true });
    expect(store.getState().status).toBe('unlocked');
    expect(await vault.repos.categories.list()).toHaveLength(13);
    expect(await vault.repos.settings.get('locale')).toBe('en-GB');
  });

  it('createVault failure leaves the session unchanged', async () => {
    const store = createSessionStore(createFakeVault({ hasVault: true, unlocked: false }));
    await store.getState().refresh();

    expect(
      await store.getState().createVault('x', { baseCurrency: 'EUR', locale: 'en' }),
    ).toMatchObject({ ok: false });
    expect(store.getState().status).toBe('locked');
  });

  it('lock drops repositories and calls onLock', async () => {
    const onLock = vi.fn();
    const vault = createFakeVault();
    const store = createSessionStore(vault, onLock);
    await store.getState().refresh();

    await store.getState().lock();

    expect(store.getState()).toMatchObject({ status: 'locked', repos: null });
    expect(onLock).toHaveBeenCalled();
    expect(vault.lock).toHaveBeenCalled();
  });

  it('unlock with a wrong passphrase stays locked', async () => {
    const store = createSessionStore(createFakeVault({ unlocked: false }));
    await store.getState().refresh();

    const result = await store.getState().unlock('nope');

    expect(result).toMatchObject({ ok: false, error: 'WRONG_PASSPHRASE' });
    expect(store.getState().status).toBe('locked');
  });

  it('records whether storage persistence was granted', async () => {
    const store = createSessionStore(createFakeVault({ unlocked: false, persisted: false }));

    await store.getState().unlock(TEST_PASSPHRASE);

    expect(store.getState().storagePersisted).toBe(false);
  });

  it('unlockWithBiometrics unlocks on success and stays locked otherwise', async () => {
    const prompt = { title: 'Unlock', cancel: 'Cancel' };
    const ok = createSessionStore(createFakeVault({ unlocked: false, biometrics: {} }));
    expect(await ok.getState().unlockWithBiometrics(prompt)).toEqual({ ok: true });
    expect(ok.getState().status).toBe('unlocked');

    const cancelled = createSessionStore(
      createFakeVault({
        unlocked: false,
        biometrics: { result: { ok: false, error: 'CANCELLED' } },
      }),
    );
    await cancelled.getState().refresh();
    expect(await cancelled.getState().unlockWithBiometrics(prompt)).toEqual({
      ok: false,
      error: 'CANCELLED',
    });
    expect(cancelled.getState().status).toBe('locked');

    const web = createSessionStore(createFakeVault({ unlocked: false }));
    expect(await web.getState().unlockWithBiometrics(prompt)).toEqual({
      ok: false,
      error: 'FAILED',
    });
  });
});
