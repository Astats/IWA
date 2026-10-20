/** How long the app may stay away on a trip it started itself (sign-in can take a while). */
export const MAX_AWAY_MS = 10 * 60_000;
/** After a trip ends while the app is still in the background, how long it waits to return. */
export const RETURN_GRACE_MS = 3_000;

export interface BackgroundLockOptions {
  maxAwayMs?: number;
  returnGraceMs?: number;
  now?: () => number;
}

/**
 * When the native app goes to the background, it locks (BUILD_PLAN 4.3, SEC-M04). The exception
 * is a trip the app sent the user on itself: the share sheet, the file picker, the sign-in
 * browser or the biometric prompt all move the app to the background, and locking would break
 * them. Such a trip locks too once it has lasted `maxAwayMs`, or when it ends while the app is
 * still in the background and the app does not return within `returnGraceMs`.
 */
export class BackgroundLock {
  readonly #handlers = new Set<() => void>();
  readonly #maxAwayMs: number;
  readonly #returnGraceMs: number;
  readonly #now: () => number;
  #trips = 0;
  #pausedAt: number | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BackgroundLockOptions = {}) {
    this.#maxAwayMs = options.maxAwayMs ?? MAX_AWAY_MS;
    this.#returnGraceMs = options.returnGraceMs ?? RETURN_GRACE_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /** `handler` runs whenever the app must lock; returns a function that removes it. */
  onLock(handler: () => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  /** The app went to the background (Capacitor `pause`). */
  paused(): void {
    if (this.#trips === 0) {
      this.#fire();
      return;
    }
    this.#pausedAt ??= this.#now();
    this.#schedule(this.#maxAwayMs - (this.#now() - this.#pausedAt));
  }

  /** The app is in the foreground again (Capacitor `resume`). */
  resumed(): void {
    const pausedAt = this.#pausedAt;
    this.#pausedAt = null;
    clearTimeout(this.#timer);
    // Timers may not run in the background, so the duration is checked again here.
    if (pausedAt !== null && this.#now() - pausedAt >= this.#maxAwayMs) this.#fire();
  }

  /** Runs `task` as a trip away from the app: leaving the app meanwhile does not lock it. */
  async away<T>(task: () => Promise<T>): Promise<T> {
    this.#trips++;
    try {
      return await task();
    } finally {
      this.#trips--;
      if (this.#trips === 0 && this.#pausedAt !== null) this.#schedule(this.#returnGraceMs);
    }
  }

  #schedule(ms: number): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(
      () => {
        this.#fire();
      },
      Math.max(0, ms),
    );
  }

  #fire(): void {
    clearTimeout(this.#timer);
    this.#pausedAt = null;
    for (const handler of [...this.#handlers]) handler();
  }
}
