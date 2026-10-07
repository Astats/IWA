import { KINDS, type Category, type Kind } from '@budget/core';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CategoryIcon } from '@/components/CategoryIcon';
import { Field, NativeSelect } from '@/components/form/Field';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useRepositories } from '@/di';
import { useCategories } from '@/hooks/useCategories';
import { useErrorMessage, useRepoMutation } from '@/hooks/useRepoMutation';

import { CategoryForm, type CategoryFormValues } from './CategoryForm';

type Mode =
  | { type: 'idle' }
  | { type: 'create'; kind: Kind }
  | { type: 'edit'; id: string }
  | { type: 'delete'; id: string };

function DeletePanel({
  category,
  others,
  onDone,
  onCancel,
}: {
  category: Category;
  others: Category[];
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const repos = useRepositories();
  const errorMessage = useErrorMessage();
  const [target, setTarget] = useState(others[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const { data: count } = useQuery({
    queryKey: ['categories', 'count', category.id],
    queryFn: () => repos.categories.countTransactions(category.id),
  });
  const remove = useRepoMutation(async (r, reassignTo: string | null) => {
    if (reassignTo) await r.categories.reassignTransactions(category.id, reassignTo);
    await r.categories.softDelete(category.id);
  });

  // mutateAsync (not mutate callbacks): this panel unmounts as soon as the refreshed list no longer
  // contains the category, and per-call mutate callbacks are skipped after unmount.
  const run = async (reassignTo: string | null) => {
    setError(null);
    try {
      await remove.mutateAsync(reassignTo);
      onDone(t('categories.deleted', { name: category.name }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (count === undefined) return null;
  return (
    <div
      className="grid gap-3 rounded-lg border border-destructive/40 p-3"
      role="group"
      aria-label={t('categories.deleteTitle', { name: category.name })}
    >
      {count === 0 ? (
        <p className="text-sm">{t('categories.deleteConfirm', { name: category.name })}</p>
      ) : (
        <>
          <p className="text-sm">{t('categories.inUse', { name: category.name, count })}</p>
          {others.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('categories.noReassignTarget')}</p>
          ) : (
            <Field label={t('categories.reassignTo')}>
              {(c) => (
                <NativeSelect
                  {...c}
                  value={target}
                  onChange={(e) => {
                    setTarget(e.target.value);
                  }}
                >
                  {others.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {count === 0 ? (
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => void run(null)}
          >
            {t('common.delete')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending || !target}
            onClick={() => void run(target)}
          >
            {t('categories.reassignAndDelete')}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

export function CategoriesPage() {
  const { t } = useTranslation();
  const { data: categories = [] } = useCategories();
  const errorMessage = useErrorMessage();
  const [mode, setMode] = useState<Mode>({ type: 'idle' });
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const create = useRepoMutation((r, values: CategoryFormValues) => r.categories.create(values));
  const update = useRepoMutation((r, v: { id: string; values: CategoryFormValues }) =>
    r.categories.update(v.id, v.values),
  );
  const reorder = useRepoMutation((r, ids: string[]) => r.categories.reorder(ids));

  const close = (message?: string) => {
    setMode({ type: 'idle' });
    setFormError(null);
    if (message) setNotice(message);
  };

  const move = (list: Category[], index: number, delta: -1 | 1) => {
    const ids = list.map((c) => c.id);
    const [moved] = ids.splice(index, 1);
    if (!moved) return;
    ids.splice(index + delta, 0, moved);
    reorder.mutate(ids);
  };

  return (
    <>
      <PageHeader title={t('categories.title')} />
      {notice && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {[...KINDS].reverse().map((kind) => {
          const list = categories.filter((c) => c.kind === kind);
          const heading =
            kind === 'expense' ? t('categories.expenseHeading') : t('categories.incomeHeading');
          return (
            <Card key={kind}>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>
                  <h2>{heading}</h2>
                </CardTitle>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setNotice(null);
                    setFormError(null);
                    setMode({ type: 'create', kind });
                  }}
                >
                  <Plus aria-hidden />
                  {kind === 'expense' ? t('categories.newExpense') : t('categories.newIncome')}
                </Button>
              </CardHeader>
              <CardContent className="grid gap-3">
                {mode.type === 'create' && mode.kind === kind && (
                  <CategoryForm
                    defaultKind={kind}
                    submitLabel={t('categories.create')}
                    error={formError}
                    onCancel={() => close()}
                    onSubmit={async (values) => {
                      setFormError(null);
                      try {
                        await create.mutateAsync(values);
                        close(t('categories.created', { name: values.name.trim() }));
                      } catch (err) {
                        setFormError(errorMessage(err));
                      }
                    }}
                  />
                )}
                <ul className="grid gap-1" aria-label={heading}>
                  {list.map((category, index) => (
                    <li key={category.id} className="grid gap-2 rounded-md border p-2">
                      {mode.type === 'edit' && mode.id === category.id ? (
                        <CategoryForm
                          initial={category}
                          submitLabel={t('common.save')}
                          error={formError}
                          onCancel={() => close()}
                          onSubmit={async (values) => {
                            setFormError(null);
                            try {
                              await update.mutateAsync({ id: category.id, values });
                              close(t('categories.updated', { name: values.name.trim() }));
                            } catch (err) {
                              setFormError(errorMessage(err));
                            }
                          }}
                        />
                      ) : (
                        <div className="flex items-center gap-2">
                          <CategoryIcon icon={category.icon} color={category.color} />
                          <span className="min-w-0 flex-1 truncate">{category.name}</span>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            disabled={index === 0 || reorder.isPending}
                            aria-label={t('categories.moveUp', { name: category.name })}
                            onClick={() => move(list, index, -1)}
                          >
                            <ArrowUp aria-hidden />
                          </Button>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            disabled={index === list.length - 1 || reorder.isPending}
                            aria-label={t('categories.moveDown', { name: category.name })}
                            onClick={() => move(list, index, 1)}
                          >
                            <ArrowDown aria-hidden />
                          </Button>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={t('categories.editLabel', { name: category.name })}
                            onClick={() => {
                              setNotice(null);
                              setFormError(null);
                              setMode({ type: 'edit', id: category.id });
                            }}
                          >
                            <Pencil aria-hidden />
                          </Button>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={t('categories.deleteLabel', { name: category.name })}
                            onClick={() => {
                              setNotice(null);
                              setMode({ type: 'delete', id: category.id });
                            }}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </div>
                      )}
                      {mode.type === 'delete' && mode.id === category.id && (
                        <DeletePanel
                          category={category}
                          others={list.filter((c) => c.id !== category.id)}
                          onDone={(message) => close(message)}
                          onCancel={() => close()}
                        />
                      )}
                    </li>
                  ))}
                </ul>
                {list.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t('categories.empty')}</p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
