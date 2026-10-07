import {
  DEFAULT_SETTINGS,
  settingsSchema,
  type Settings,
  type SettingsRepository,
} from '@budget/core';
import type { RepoContext } from './context';
import { currentSchemaVersion } from './migrator';
import { settings } from './schema';

/** Settings keys as stored in the `settings` table (BUILD_PLAN §4.1). */
const STORAGE_KEYS = {
  baseCurrency: 'base_currency',
  locale: 'locale',
  theme: 'theme',
  autoLockMinutes: 'auto_lock_minutes',
  schemaVersion: 'schema_version',
} as const satisfies Record<keyof Settings, string>;

type WritableKey = Exclude<keyof Settings, 'schemaVersion'>;

export class SqliteSettingsRepository implements SettingsRepository {
  constructor(private readonly ctx: RepoContext) {}

  async getAll(): Promise<Settings> {
    const rows = await this.ctx.db.select().from(settings);
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const [key, column] of Object.entries(STORAGE_KEYS)) {
      const raw = stored.get(column);
      if (raw === undefined) continue;
      try {
        const value: unknown = JSON.parse(raw);
        const field = settingsSchema.shape[key as keyof Settings];
        // Invalid stored values fall back to the default instead of breaking the app.
        if (field.safeParse(value).success) result[key] = value;
      } catch {
        // ignore malformed JSON (default stays)
      }
    }
    result.schemaVersion = await currentSchemaVersion(this.ctx.driver);
    return settingsSchema.parse(result);
  }

  async get<K extends keyof Settings>(key: K): Promise<Settings[K]> {
    return (await this.getAll())[key];
  }

  async set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    if (key === 'schemaVersion') throw new Error('schemaVersion is managed by migrations');
    const parsed: unknown = settingsSchema.shape[key].parse(value);
    const row = { key: STORAGE_KEYS[key], value: JSON.stringify(parsed) };
    await this.ctx.db
      .insert(settings)
      .values(row)
      .onConflictDoUpdate({ target: settings.key, set: { value: row.value } });
  }
}

/** `settings` table rows for all user-editable settings (used by restore). */
export function settingsRows(value: Settings): Array<{ key: string; value: string }> {
  const parsed = settingsSchema.parse(value);
  return (Object.keys(STORAGE_KEYS) as Array<keyof Settings>)
    .filter((key): key is WritableKey => key !== 'schemaVersion')
    .map((key) => ({ key: STORAGE_KEYS[key], value: JSON.stringify(parsed[key]) }));
}
