import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackgroundLock } from './background-lock';

const MAX = 60_000;
const GRACE = 3_000;

function setup() {
  const lock = new BackgroundLock({ maxAwayMs: MAX, returnGraceMs: GRACE });
  const handler = vi.fn();
  lock.onLock(handler);
  return { lock, handler };
}

/** A trip the test ends by resolving `end`. */
function trip(lock: BackgroundLock) {
  let end!: () => void;
  const done = lock.away(() => new Promise<void>((resolve) => (end = resolve)));
  return { end: () => (end(), done) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BackgroundLock (SEC-M04)', () => {
  it('locks at once when the user leaves the app', () => {
    const { lock, handler } = setup();

    lock.paused();

    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not lock while the app sent the user away and they come back', async () => {
    const { lock, handler } = setup();
    const t = trip(lock);

    lock.paused();
    vi.advanceTimersByTime(MAX - 1);
    lock.resumed();
    await t.end();
    vi.advanceTimersByTime(MAX);

    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts a trip that ends just before the app comes back (deep link, then resume)', async () => {
    const { lock, handler } = setup();
    const t = trip(lock);
    lock.paused();

    await t.end();
    vi.advanceTimersByTime(GRACE - 1);
    lock.resumed();
    vi.advanceTimersByTime(MAX);

    expect(handler).not.toHaveBeenCalled();
  });

  it('locks when a trip ends and the app stays in the background', async () => {
    const { lock, handler } = setup();
    const t = trip(lock);
    lock.paused();

    await t.end();
    vi.advanceTimersByTime(GRACE);

    expect(handler).toHaveBeenCalledOnce();
  });

  it('locks when a trip lasts too long, even without a resume', () => {
    const { lock, handler } = setup();
    trip(lock);

    lock.paused();
    vi.advanceTimersByTime(MAX);

    expect(handler).toHaveBeenCalledOnce();
  });

  it('locks on resume when the timers did not run in the background', () => {
    let now = 0;
    const lock = new BackgroundLock({ maxAwayMs: MAX, now: () => now });
    const handler = vi.fn();
    lock.onLock(handler);
    trip(lock);

    lock.paused();
    vi.clearAllTimers();
    now = MAX;
    lock.resumed();

    expect(handler).toHaveBeenCalledOnce();
  });

  it('locks normally again after the trip is over', async () => {
    const { lock, handler } = setup();
    const t = trip(lock);
    await t.end();

    lock.paused();

    expect(handler).toHaveBeenCalledOnce();
  });

  it('counts overlapping trips and passes the task result through', async () => {
    const { lock, handler } = setup();
    const a = trip(lock);
    const b = trip(lock);
    lock.paused();
    await a.end();
    vi.advanceTimersByTime(GRACE);

    expect(handler).not.toHaveBeenCalled();
    await b.end();
    vi.advanceTimersByTime(GRACE);
    expect(handler).toHaveBeenCalledOnce();
    await expect(lock.away(() => Promise.resolve(42))).resolves.toBe(42);
  });

  it('ends the trip when the task fails', async () => {
    const { lock, handler } = setup();

    await expect(lock.away(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    lock.paused();

    expect(handler).toHaveBeenCalledOnce();
  });

  it('stops calling a removed handler', () => {
    const lock = new BackgroundLock();
    const handler = vi.fn();
    const off = lock.onLock(handler);
    off();

    lock.paused();

    expect(handler).not.toHaveBeenCalled();
  });
});
