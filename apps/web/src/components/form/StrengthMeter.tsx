import { checkPassphrase } from '@budget/core';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

const BAR_COLORS = [
  'bg-destructive',
  'bg-destructive',
  'bg-amber-500',
  'bg-lime-600',
  'bg-emerald-600',
];

/** Passphrase strength meter (ASVS V6). Purely informational; the policy check decides. */
export function StrengthMeter({ passphrase }: { passphrase: string }) {
  const { t } = useTranslation();
  const { strength } = checkPassphrase(passphrase);
  const label = t('passphrase.strength', { label: t(`passphrase.strengthLabels.${strength}`) });
  return (
    <div className="grid gap-1">
      <meter
        className="sr-only"
        min={0}
        max={4}
        low={2}
        high={3}
        optimum={4}
        value={strength}
        aria-label={label}
      />
      <div className="flex gap-1" aria-hidden>
        {[1, 2, 3, 4].map((step) => (
          <span
            key={step}
            className={cn(
              'h-1.5 flex-1 rounded-full',
              passphrase && strength >= step ? BAR_COLORS[strength] : 'bg-muted',
            )}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {passphrase ? label : '\u00a0'}
      </p>
    </div>
  );
}
