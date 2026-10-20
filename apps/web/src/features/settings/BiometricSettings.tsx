import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Field } from '@/components/form/Field';
import { PassphraseInput } from '@/components/form/PassphraseInput';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useServices, type BiometricUnlock } from '@/di';

type State = { available: false } | { available: true; enabled: boolean };

/**
 * Turns biometric unlock on or off (BUILD_PLAN 4.3). Shown only on native devices with strong
 * biometrics. Turning it on asks for the passphrase again; the passphrase always keeps working.
 */
export function BiometricSettings() {
  const { vault } = useServices();
  const biometrics = vault.biometrics;
  const [state, setState] = useState<State>({ available: false });

  useEffect(() => {
    if (!biometrics) return;
    let active = true;
    void Promise.all([biometrics.isAvailable(), biometrics.isEnabled()]).then(
      ([available, enabled]) => {
        if (active) setState(available ? { available, enabled } : { available: false });
      },
    );
    return () => {
      active = false;
    };
  }, [biometrics]);

  if (!biometrics || !state.available) return null;
  return (
    <BiometricCard
      biometrics={biometrics}
      enabled={state.enabled}
      onChange={(enabled) => {
        setState({ available: true, enabled });
      }}
    />
  );
}

function BiometricCard({
  biometrics,
  enabled,
  onChange,
}: {
  biometrics: BiometricUnlock;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const turnOn = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setFailed(false);
    const result = await biometrics.enable(passphrase);
    setBusy(false);
    setPassphrase('');
    if (result.ok) onChange(true);
    else setFailed(true);
  };

  const turnOff = async () => {
    setBusy(true);
    await biometrics.disable();
    setBusy(false);
    onChange(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t('settings.biometric.title')}</h2>
        </CardTitle>
        <CardDescription>{t('settings.biometric.intro')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p role="status" className="text-sm">
          {enabled ? t('settings.biometric.on') : t('settings.biometric.off')}
        </p>
        {enabled ? (
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            disabled={busy}
            onClick={() => void turnOff()}
          >
            {t('settings.biometric.turnOff')}
          </Button>
        ) : (
          <form className="grid gap-4" onSubmit={(e) => void turnOn(e)} noValidate>
            <Field label={t('settings.currentPassphrase')} hint={t('settings.biometric.confirm')}>
              {(control) => (
                <PassphraseInput
                  {...control}
                  value={passphrase}
                  onChange={(e) => {
                    setPassphrase(e.target.value);
                  }}
                />
              )}
            </Field>
            {failed && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{t('settings.biometric.failed')}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" className="justify-self-start" disabled={busy || !passphrase}>
              {t('settings.biometric.turnOn')}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
