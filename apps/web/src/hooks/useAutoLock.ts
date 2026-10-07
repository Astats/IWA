import { useEffect } from 'react';

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Calls `onTimeout` after `minutes` without user activity (BUILD_PLAN §6.2). Any pointer, key,
 * wheel or touch event resets the timer.
 */
export function useAutoLock(minutes: number | undefined, onTimeout: () => void): void {
  useEffect(() => {
    if (!minutes || minutes <= 0) return;
    const ms = minutes * 60_000;
    let timer = setTimeout(onTimeout, ms);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(onTimeout, ms);
    };
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, reset, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, reset);
    };
  }, [minutes, onTimeout]);
}
