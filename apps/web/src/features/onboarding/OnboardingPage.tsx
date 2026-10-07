import { checkPassphrase, currencySchema, SUPPORTED_CURRENCIES } from '@budget/core';
import { zodResolver } from '@hookform/resolvers/zod';
import { ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { z } from 'zod';

import { Field, NativeSelect } from '@/components/form/Field';
import { PassphraseInput } from '@/components/form/PassphraseInput';
import { StrengthMeter } from '@/components/form/StrengthMeter';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSession } from '@/di';
import { useFormatters } from '@/hooks/useFormatters';
import { changeLocale, LOCALE_OPTIONS } from '@/i18n';
import { writeUiPrefs } from '@/lib/ui-prefs';

const schema = z
  .object({
    passphrase: z.string().superRefine((value, ctx) => {
      for (const issue of checkPassphrase(value).issues)
        ctx.addIssue({ code: 'custom', message: issue });
    }),
    confirm: z.string(),
    acknowledged: z.boolean().refine((v) => v, { message: 'ACK_REQUIRED' }),
    baseCurrency: currencySchema,
    locale: z.string().min(2),
  })
  .refine((d) => d.passphrase === d.confirm, { path: ['confirm'], message: 'MISMATCH' });

type FormValues = z.infer<typeof schema>;
type Step = 'welcome' | 'passphrase' | 'preferences';

export function defaultCurrencyFor(locale: string): string {
  const region = locale.split('-')[1]?.toUpperCase();
  const byRegion: Record<string, string> = { US: 'USD', GB: 'GBP', JP: 'JPY', CH: 'CHF' };
  return (region && byRegion[region]) ?? 'EUR';
}

export function OnboardingPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const createVault = useSession((s) => s.createVault);
  const fmt = useFormatters();
  const [step, setStep] = useState<Step>('welcome');
  const [failed, setFailed] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      passphrase: '',
      confirm: '',
      acknowledged: false,
      baseCurrency: defaultCurrencyFor(i18n.language),
      locale: (LOCALE_OPTIONS as readonly string[]).includes(i18n.language)
        ? i18n.language
        : 'en-US',
    },
    mode: 'onTouched',
  });
  const { register, handleSubmit, trigger, formState, control } = form;
  const passphrase = useWatch({ control, name: 'passphrase' });
  const errors = formState.errors;

  const localeNames = useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([fmt.locale], { type: 'language' });
    } catch {
      names = null;
    }
    return (code: string) => names?.of(code) ?? code;
  }, [fmt.locale]);

  const passphraseError = (message: string | undefined) =>
    message === 'ACK_REQUIRED'
      ? t('onboarding.acknowledgeRequired')
      : message
        ? t(`passphrase.errors.${message}`, { defaultValue: t('validation.invalid') })
        : undefined;

  const onSubmit = handleSubmit(async (values) => {
    setFailed(false);
    const result = await createVault(values.passphrase, {
      baseCurrency: values.baseCurrency,
      locale: values.locale,
    });
    if (!result.ok) {
      setFailed(true);
      return;
    }
    writeUiPrefs({ locale: values.locale });
    void navigate('/', { replace: true });
  });

  const total = 2;
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center p-4">
      <Card>
        {step === 'welcome' && (
          <>
            <CardHeader>
              <CardTitle>
                <h1 className="text-2xl font-semibold">{t('onboarding.title')}</h1>
              </CardTitle>
              <CardDescription>{t('onboarding.intro')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                type="button"
                className="w-full"
                onClick={() => {
                  setStep('passphrase');
                }}
              >
                {t('onboarding.start')}
              </Button>
            </CardContent>
          </>
        )}
        {step !== 'welcome' && (
          <form onSubmit={(e) => void onSubmit(e)} noValidate>
            <CardHeader>
              <p className="text-xs text-muted-foreground">
                {t('onboarding.step', { current: step === 'passphrase' ? 1 : 2, total })}
              </p>
              <CardTitle>
                <h1 className="text-xl font-semibold">
                  {step === 'passphrase'
                    ? t('onboarding.passphraseTitle')
                    : t('onboarding.preferencesTitle')}
                </h1>
              </CardTitle>
              {step === 'passphrase' && (
                <CardDescription>{t('onboarding.passphraseIntro')}</CardDescription>
              )}
            </CardHeader>
            <CardContent className="grid gap-4">
              {step === 'passphrase' && (
                <>
                  <Field
                    label={t('passphrase.label')}
                    hint={t('passphrase.hint')}
                    error={passphraseError(errors.passphrase?.message)}
                  >
                    {(control) => (
                      <PassphraseInput
                        {...control}
                        autoComplete="new-password"
                        {...register('passphrase')}
                      />
                    )}
                  </Field>
                  <StrengthMeter passphrase={passphrase} />
                  <Field
                    label={t('passphrase.confirmLabel')}
                    error={passphraseError(errors.confirm?.message)}
                  >
                    {(control) => (
                      <PassphraseInput
                        {...control}
                        autoComplete="new-password"
                        {...register('confirm')}
                      />
                    )}
                  </Field>
                  <Alert variant="destructive">
                    <ShieldAlert aria-hidden />
                    <AlertDescription>{t('onboarding.lossWarning')}</AlertDescription>
                  </Alert>
                  <div className="grid gap-1">
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 accent-primary"
                        aria-invalid={!!errors.acknowledged}
                        aria-describedby={errors.acknowledged ? 'ack-error' : undefined}
                        {...register('acknowledged')}
                      />
                      <span>{t('onboarding.acknowledge')}</span>
                    </label>
                    {errors.acknowledged && (
                      <p id="ack-error" className="text-xs font-medium text-destructive">
                        {t('onboarding.acknowledgeRequired')}
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    onClick={() => {
                      void trigger(['passphrase', 'confirm', 'acknowledged'], {
                        shouldFocus: true,
                      }).then((ok) => {
                        if (ok) setStep('preferences');
                      });
                    }}
                  >
                    {t('common.next')}
                  </Button>
                </>
              )}
              {step === 'preferences' && (
                <>
                  <Field
                    label={t('onboarding.baseCurrency')}
                    hint={t('onboarding.baseCurrencyHint')}
                    error={errors.baseCurrency ? t('validation.invalid') : undefined}
                  >
                    {(control) => (
                      <NativeSelect {...control} {...register('baseCurrency')}>
                        {SUPPORTED_CURRENCIES.map((code) => (
                          <option key={code} value={code}>
                            {code} — {fmt.currencyName(code)}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <Field label={t('onboarding.language')}>
                    {(control) => (
                      <NativeSelect
                        {...control}
                        {...register('locale', {
                          onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
                            changeLocale(e.target.value);
                          },
                        })}
                      >
                        {LOCALE_OPTIONS.map((code) => (
                          <option key={code} value={code}>
                            {localeNames(code)}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  {failed && (
                    <Alert variant="destructive" role="alert">
                      <AlertDescription>{t('onboarding.createFailed')}</AlertDescription>
                    </Alert>
                  )}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setStep('passphrase');
                      }}
                    >
                      {t('common.back')}
                    </Button>
                    <Button type="submit" className="flex-1" disabled={formState.isSubmitting}>
                      {formState.isSubmitting ? t('onboarding.creating') : t('onboarding.create')}
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </form>
        )}
      </Card>
    </main>
  );
}
