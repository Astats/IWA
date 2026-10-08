import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { backupReminder, isBackupReminderDue, nextBackupDue } from './backup-schedule';

const DAY = 24 * 60 * 60 * 1000;
const LAST = '2026-03-10T08:00:00.000Z';

describe('nextBackupDue', () => {
  it.each([
    ['daily', '2026-03-11T08:00:00.000Z'],
    ['weekly', '2026-03-17T08:00:00.000Z'],
  ] as const)('%s → one interval after the last backup', (frequency, expected) => {
    expect(nextBackupDue(frequency, LAST)?.toISOString()).toBe(expected);
  });

  it('is null for manual, no backup yet, or an unreadable timestamp', () => {
    expect(nextBackupDue('manual', LAST)).toBeNull();
    expect(nextBackupDue('weekly', null)).toBeNull();
    expect(nextBackupDue('weekly', 'not a date')).toBeNull();
  });
});

describe('backupReminder', () => {
  const at = (iso: string) => new Date(iso);

  it('is off for manual backups, whatever the state', () => {
    expect(
      backupReminder({ frequency: 'manual', lastBackupAt: null, hasData: true, now: at(LAST) }),
    ).toEqual({
      state: 'off',
    });
  });

  it('does not nag before there is any data', () => {
    expect(
      backupReminder({ frequency: 'daily', lastBackupAt: null, hasData: false, now: at(LAST) }),
    ).toEqual({
      state: 'empty',
    });
  });

  it('reminds when there is data but never a backup', () => {
    const r = backupReminder({
      frequency: 'weekly',
      lastBackupAt: null,
      hasData: true,
      now: at(LAST),
    });
    expect(r).toEqual({ state: 'never' });
    expect(isBackupReminderDue(r)).toBe(true);
  });

  it('is ok until exactly one interval has passed, then overdue', () => {
    const justBefore = backupReminder({
      frequency: 'daily',
      lastBackupAt: LAST,
      hasData: true,
      now: new Date(Date.parse(LAST) + DAY - 1),
    });
    expect(justBefore).toEqual({ state: 'ok', dueAt: at('2026-03-11T08:00:00.000Z') });
    expect(isBackupReminderDue(justBefore)).toBe(false);

    const exactly = backupReminder({
      frequency: 'daily',
      lastBackupAt: LAST,
      hasData: true,
      now: at('2026-03-11T08:00:00.000Z'),
    });
    expect(exactly).toEqual({ state: 'overdue', since: at('2026-03-11T08:00:00.000Z') });
    expect(isBackupReminderDue(exactly)).toBe(true);
  });

  it('treats a last backup in the future (clock changed) as up to date', () => {
    const r = backupReminder({
      frequency: 'weekly',
      lastBackupAt: '2026-04-01T00:00:00.000Z',
      hasData: true,
      now: at(LAST),
    });
    expect(r.state).toBe('ok');
  });
});

describe('backupReminder over time (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(LAST));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const reminderNow = (frequency: 'daily' | 'weekly') =>
    backupReminder({ frequency, lastBackupAt: LAST, hasData: true, now: new Date() }).state;

  it('a weekly reminder turns due after seven days, not six', () => {
    vi.advanceTimersByTime(6 * DAY);
    expect(reminderNow('weekly')).toBe('ok');
    vi.advanceTimersByTime(DAY);
    expect(reminderNow('weekly')).toBe('overdue');
  });

  it('a daily reminder turns due after one day across a DST change (instants, not wall time)', () => {
    vi.setSystemTime(new Date('2026-03-28T12:00:00.000Z'));
    const last = new Date().toISOString();
    vi.advanceTimersByTime(DAY - 1000);
    expect(
      backupReminder({ frequency: 'daily', lastBackupAt: last, hasData: true, now: new Date() })
        .state,
    ).toBe('ok');
    vi.advanceTimersByTime(1000);
    expect(
      backupReminder({ frequency: 'daily', lastBackupAt: last, hasData: true, now: new Date() })
        .state,
    ).toBe('overdue');
  });
});
