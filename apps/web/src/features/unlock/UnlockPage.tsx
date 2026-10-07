import { Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import { Field } from '@/components/form/Field';
import { PassphraseInput } from '@/components/form/PassphraseInput';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSession, type VaultErrorCode } from '@/di';

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

export function UnlockPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const unlock = useSession((s) => s.unlock);
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

  const onSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!passphrase || busy || remainingSeconds > 0) return;
    setBusy(true);
    setError(null);
    const result = await unlock(passphrase);
    setBusy(false);
    if (result.ok) {
      setPassphrase('');
      void navigate(from.startsWith('/') && !from.startsWith('//') ? from : '/', { replace: true });
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
        </CardContent>
      </Card>
    </main>
  );
}
