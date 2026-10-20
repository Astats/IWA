import { FingerprintPattern, Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import { Field } from '@/components/form/Field';
import { PassphraseInput } from '@/components/form/PassphraseInput';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useServices, useSession, type BiometricErrorCode, type VaultErrorCode } from '@/di';

function messageKey(error: VaultErrorCode): string {
  switch (error) {
    case 'CORRUPT':
      return 'unlock.corrupt';
    case 'UNSUPPORTED_VERSION':
      return 'unlock.unsupported';
    default:
      // Wrong passphrase and anything unexpected share one generic message (A07).
      return 'unlock.failed';
  }
}

function biometricMessageKey(error: BiometricErrorCode): string | null {
  switch (error) {
    case 'CANCELLED':
      return null;
    case 'LOCKED_OUT':
      return 'unlock.biometricLockedOut';
    case 'INVALIDATED':
      return 'unlock.biometricInvalidated';
    default:
      return 'unlock.biometricFailed';
  }
}

/** Offered when biometric unlock is turned on and usable on this device (native only). */
function useBiometricUnlockOffered(): [boolean, (offered: boolean) => void] {
  const { vault } = useServices();
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    const biometrics = vault.biometrics;
    if (!biometrics) return;
    let active = true;
    void Promise.all([biometrics.isEnabled(), biometrics.isAvailable()]).then(
      ([enabled, available]) => {
        if (active) setOffered(enabled && available);
      },
    );
    return () => {
      active = false;
    };
  }, [vault]);
  return [offered, setOffered];
}

export function UnlockPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const unlock = useSession((s) => s.unlock);
  const unlockWithBiometrics = useSession((s) => s.unlockWithBiometrics);
  const [biometricOffered, setBiometricOffered] = useBiometricUnlockOffered();
  const [biometricError, setBiometricError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<VaultErrorCode | null>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  const remainingSeconds = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  useEffect(() => {
    if (waitUntil <= Date.now()) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => {
      clearInterval(timer);
    };
  }, [waitUntil]);

  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const enterApp = () => {
    void navigate(from.startsWith('/') && !from.startsWith('//') ? from : '/', { replace: true });
  };

  const onBiometric = async () => {
    if (busy) return;
    setBusy(true);
    setBiometricError(null);
    const result = await unlockWithBiometrics({
      title: t('unlock.biometricPrompt'),
      cancel: t('unlock.usePassphrase'),
    });
    setBusy(false);
    if (result.ok) {
      enterApp();
      return;
    }
    if (result.error === 'INVALIDATED') setBiometricOffered(false);
    setBiometricError(biometricMessageKey(result.error));
  };

  const onSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!passphrase || busy || remainingSeconds > 0) return;
    setBusy(true);
    setError(null);
    const result = await unlock(passphrase);
    setBusy(false);
    if (result.ok) {
      setPassphrase('');
      enterApp();
      return;
    }
    setError(result.error);
    setPassphrase('');
    if (result.retryAfterMs) {
      setWaitUntil(Date.now() + result.retryAfterMs);
      setNow(Date.now());
    }
    inputRef.current?.focus();
  };

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-4">
      <Card>
        <CardHeader>
          <Lock aria-hidden className="mb-2 size-6 text-muted-foreground" />
          <CardTitle>
            <h1 className="text-xl font-semibold">{t('unlock.title')}</h1>
          </CardTitle>
          <CardDescription>{t('unlock.intro')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={(e) => void onSubmit(e)} noValidate>
            <Field label={t('passphrase.label')}>
              {(control) => (
                <PassphraseInput
                  {...control}
                  ref={inputRef}
                  value={passphrase}
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- single-purpose screen; focus the only field
                  autoFocus
                  onChange={(e) => {
                    setPassphrase(e.target.value);
                  }}
                />
              )}
            </Field>
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{t(messageKey(error))}</AlertDescription>
              </Alert>
            )}
            {remainingSeconds > 0 && (
              <p className="text-sm text-muted-foreground" role="status">
                {t('unlock.wait', { seconds: remainingSeconds })}
              </p>
            )}
            <Button type="submit" disabled={busy || !passphrase || remainingSeconds > 0}>
              {busy ? t('unlock.unlocking') : t('unlock.submit')}
            </Button>
          </form>
          {biometricOffered && (
            <Button
              type="button"
              variant="outline"
              className="mt-4 w-full"
              disabled={busy}
              onClick={() => void onBiometric()}
            >
              <FingerprintPattern aria-hidden /> {t('unlock.biometric')}
            </Button>
          )}
          {biometricError && (
            <Alert className="mt-4" role="alert">
              <AlertDescription>{t(biometricError)}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
