import { useCallback, type MouseEvent } from 'react';

import { useServices } from '@/di';

/**
 * `onClick` for an `<input type="file">`: on native the system picker sends the app to the
 * background, which must not lock it (BUILD_PLAN 4.3). The trip ends when a file is picked, the
 * picker is cancelled, or the page is visible again after being hidden (older WebViews fire no
 * `cancel`).
 */
export function usePickerTrip(): (event: MouseEvent<HTMLInputElement>) => void {
  const { platform } = useServices();
  return useCallback(
    (event: MouseEvent<HTMLInputElement>) => {
      if (!platform.isNative()) return;
      const input = event.currentTarget;
      void platform.away(
        () =>
          new Promise<void>((resolve) => {
            let hidden = false;
            const onVisibility = () => {
              if (document.visibilityState === 'hidden') hidden = true;
              else if (hidden) done();
            };
            const done = () => {
              input.removeEventListener('change', done);
              input.removeEventListener('cancel', done);
              document.removeEventListener('visibilitychange', onVisibility);
              resolve();
            };
            input.addEventListener('change', done);
            input.addEventListener('cancel', done);
            document.addEventListener('visibilitychange', onVisibility);
          }),
      );
    },
    [platform],
  );
}
