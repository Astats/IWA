import { Eye, EyeOff } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Password input with a show/hide toggle. Never autocompleted into other fields or logged. */
export function PassphraseInput({
  autoComplete = 'current-password',
  ...props
}: ComponentProps<typeof Input>) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex gap-1">
      <Input
        {...props}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-pressed={visible}
        aria-label={visible ? t('passphrase.toggleHide') : t('passphrase.toggle')}
        onClick={() => {
          setVisible((v) => !v);
        }}
      >
        {visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
      </Button>
    </div>
  );
}
