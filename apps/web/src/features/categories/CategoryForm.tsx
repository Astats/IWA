import { CATEGORY_ICONS, newCategorySchema, type Category, type Kind } from '@budget/core';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';

import { CATEGORY_ICON_COMPONENTS } from '@/components/CategoryIcon';
import { Field, NativeSelect } from '@/components/form/Field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const formSchema = newCategorySchema.omit({ sortOrder: true });
export type CategoryFormValues = z.infer<typeof formSchema>;

export function CategoryForm({
  initial,
  defaultKind = 'expense',
  submitLabel,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: Category;
  defaultKind?: Kind;
  submitLabel: string;
  error?: string | null;
  onSubmit: (values: CategoryFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { register, handleSubmit, formState, control } = useForm<CategoryFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: initial?.name ?? '',
      kind: initial?.kind ?? defaultKind,
      color: initial?.color ?? '#0f766e',
      icon: initial?.icon ?? 'tag',
    },
  });
  const selectedIcon = useWatch({ control, name: 'icon' });

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
      aria-label={submitLabel}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto]">
        <Field
          label={t('categories.name')}
          error={formState.errors.name ? t('categories.nameInvalid') : undefined}
        >
          {(c) => <Input {...c} maxLength={50} autoComplete="off" {...register('name')} />}
        </Field>
        <Field label={t('categories.kind')}>
          {(c) => (
            <NativeSelect {...c} {...register('kind')}>
              <option value="expense">{t('common.expense')}</option>
              <option value="income">{t('common.income')}</option>
            </NativeSelect>
          )}
        </Field>
        <Field label={t('categories.color')}>
          {(c) => (
            <input
              {...c}
              type="color"
              className="h-8 w-14 cursor-pointer rounded-lg border border-input bg-transparent"
              {...register('color')}
            />
          )}
        </Field>
      </div>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">{t('categories.icon')}</legend>
        <div className="flex flex-wrap gap-1">
          {CATEGORY_ICONS.map((icon) => {
            const Icon = CATEGORY_ICON_COMPONENTS[icon];
            return (
              <label
                key={icon}
                className={cn(
                  'relative flex size-9 cursor-pointer items-center justify-center rounded-md border has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50',
                  selectedIcon === icon
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input',
                )}
              >
                <input
                  type="radio"
                  className="absolute inset-0 cursor-pointer appearance-none opacity-0"
                  value={icon}
                  aria-label={t(`categories.icons.${icon}`)}
                  {...register('icon')}
                />
                <Icon aria-hidden className="size-4" />
              </label>
            );
          })}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={formState.isSubmitting}>
          {submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
