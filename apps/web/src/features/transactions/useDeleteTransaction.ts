import { useTranslation } from 'react-i18next';

import { useToast } from '@/components/toast/Toaster';
import { useErrorMessage, useRepoMutation } from '@/hooks/useRepoMutation';

/** Soft-deletes a transaction and offers Undo (restore) in a toast. */
export function useDeleteTransaction() {
  const { t } = useTranslation();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const remove = useRepoMutation((r, id: string) => r.transactions.softDelete(id));
  const restore = useRepoMutation((r, id: string) => r.transactions.restore(id));

  return async (id: string): Promise<boolean> => {
    try {
      await remove.mutateAsync(id);
    } catch (err) {
      toast({ message: errorMessage(err) });
      return false;
    }
    toast({
      message: t('transactions.deleted'),
      action: {
        label: t('common.undo'),
        onClick: () => {
          restore.mutateAsync(id).then(
            () => {
              toast({ message: t('transactions.restored') });
            },
            (err: unknown) => {
              toast({ message: errorMessage(err) });
            },
          );
        },
      },
    });
    return true;
  };
}
