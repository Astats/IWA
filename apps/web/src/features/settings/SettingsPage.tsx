import {
  checkPassphrase,
  settingsSchema,
  SUPPORTED_CURRENCIES,
  THEMES,
  type Settings,
} from '@budget/core';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { Field, NativeSelect } from '@/components/form/Field';
import { PassphraseInput } from '@/components/form/PassphraseInput';
import { StrengthMeter } from '@/components/form/StrengthMeter';
import { PageHeader } from '@/components/layout/PageHeader';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useServices } from '@/di';
import { useFormatters } from '@/hooks/useFormatters';
import { useSettings, useUpdateSettings } from '@/hooks/useSettings';
import { LOCALE_OPTIONS } from '@/i18n';

// Explicit pick: settings edited elsewhere (backup retention) must not be reset by this form.
const preferencesSchema = settingsSchema.pick({
  baseCurrency: true,
  locale: true,
  theme: true,
  autoLockMinutes: true,
});
type Preferences = z.infer<typeof preferencesSchema>;

function PreferencesForm({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const update = useUpdateSettings();
  const [saved, setSaved] = useState(false);
  const { register, handleSubmit, formState } = useForm<Preferences>({
    resolver: zodResolver(preferencesSchema),
    defaultValues: {
      baseCurrency: settings.baseCurrency,
      locale: settings.locale,
      theme: settings.theme,
      autoLockMinutes: settings.autoLockMinutes,
    },
  });
  const languageNames = (() => {
    try {
      return new Intl.DisplayNames([fmt.locale], { type: 'language' });
    } catch {
      return null;
    }
  })();
  const locales = (LOCALE_OPTIONS as readonly string[]).includes(settings.locale)
    ? LOCALE_OPTIONS
    : [settings.locale, ...LOCALE_OPTIONS];

  const onSubmit = handleSubmit(async (values) => {
    setSaved(false);
    await update.mutateAsync(values);
    setSaved(true);
  });

  return (
    <form className="grid gap-4" onSubmit={(e) => void onSubmit(e)} noValidate>
      <Field label={t('settings.baseCurrency')}>
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
      <Field label={t('settings.language')}>
        {(control) => (
          <NativeSelect {...control} {...register('locale')}>
            {locales.map((code) => (
              <option key={code} value={code}>
                {languageNames?.of(code) ?? code}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label={t('settings.theme')}>
        {(control) => (
          <NativeSelect {...control} {...register('theme')}>
            {THEMES.map((theme) => (
              <option key={theme} value={theme}>
                {t(`settings.themes.${theme}`)}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field
        label={t('settings.autoLock')}
        hint={t('settings.autoLockHint')}
        error={formState.errors.autoLockMinutes ? t('validation.invalid') : undefined}
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            inputMode="numeric"
            min={1}
            max={120}
            {...register('autoLockMinutes', { valueAsNumber: true })}
          />
        )}
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={formState.isSubmitting}>
          {t('common.save')}
        </Button>
        {saved && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('settings.saved')}
          </p>
        )}
      </div>
    </form>
  );
}

const passphraseSchema = z
  .object({
    current: z.string().min(1, 'REQUIRED'),
    next: z.string().superRefine((value, ctx) => {
      for (const issue of checkPassphrase(value).issues)
        ctx.addIssue({ code: 'custom', message: issue });
    }),
    confirm: z.string(),
  })
  .refine((d) => d.next === d.confirm, { path: ['confirm'], message: 'MISMATCH' });
type PassphraseValues = z.infer<typeof passphraseSchema>;

function ChangePassphraseForm() {
  const { t } = useTranslation();
  const { vault } = useServices();
  const [result, setResult] = useState<'ok' | 'failed' | null>(null);
  const { register, handleSubmit, formState, control, reset } = useForm<PassphraseValues>({
    resolver: zodResolver(passphraseSchema),
    defaultValues: { current: '', next: '', confirm: '' },
  });
  const next = useWatch({ control, name: 'next' });
  const message = (code: string | undefined) =>
    code === 'REQUIRED'
      ? t('validation.required')
      : code
        ? t(`passphrase.errors.${code}`, { defaultValue: t('validation.invalid') })
        : undefined;

  const onSubmit = handleSubmit(async (values) => {
    setResult(null);
    const r = await vault.changePassphrase(values.current, values.next);
    setResult(r.ok ? 'ok' : 'failed');
    if (r.ok) reset();
  });

  return (
    <form className="grid gap-4" onSubmit={(e) => void onSubmit(e)} noValidate>
      <Field
        label={t('settings.currentPassphrase')}
        error={message(formState.errors.current?.message)}
      >
        {(c) => <PassphraseInput {...c} {...register('current')} />}
      </Field>
      <Field
        label={t('settings.newPassphrase')}
        hint={t('passphrase.hint')}
        error={message(formState.errors.next?.message)}
      >
        {(c) => <PassphraseInput {...c} autoComplete="new-password" {...register('next')} />}
      </Field>
      <StrengthMeter passphrase={next} />
      <Field
        label={t('passphrase.confirmLabel')}
        error={message(formState.errors.confirm?.message)}
      >
        {(c) => <PassphraseInput {...c} autoComplete="new-password" {...register('confirm')} />}
      </Field>
      {result === 'failed' && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('settings.passphraseChangeFailed')}</AlertDescription>
        </Alert>
      )}
      {result === 'ok' && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('settings.passphraseChanged')}
        </p>
      )}
      <Button type="submit" disabled={formState.isSubmitting} className="justify-self-start">
        {t('settings.changePassphraseSubmit')}
      </Button>
    </form>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  return (
    <>
      <PageHeader title={t('settings.title')} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t('settings.general')}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>{settings && <PreferencesForm settings={settings} />}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t('settings.changePassphrase')}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ChangePassphraseForm />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
