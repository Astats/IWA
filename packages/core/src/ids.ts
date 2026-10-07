import { v7 as uuidv7 } from 'uuid';

/** New client-side id (UUID v7, time-ordered; AD10). */
export function newId(): string {
  return uuidv7();
}

/**
 * A clock that never goes backwards and never repeats a timestamp, so `updated_at` is strictly
 * monotonic even for several writes in the same millisecond (or after a system clock step back).
 */
export function createMonotonicClock(now: () => Date = () => new Date()): () => string {
  let last = 0;
  return () => {
    const t = Math.max(now().getTime(), last + 1);
    last = t;
    return new Date(t).toISOString();
  };
}
