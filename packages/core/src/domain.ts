import './zod-config';

import { z } from 'zod';

import { BACKUP_FREQUENCIES } from './backup-schedule';
import { DomainError } from './errors';
import { isSupportedCurrency, MAX_AMOUNT_MINOR } from './money';

export const KINDS = ['income', 'expense'] as const;
export type Kind = (typeof KINDS)[number];

/** Fixed icon allow-list (keys map to icon components in the UI). */
export const CATEGORY_ICONS = [
  'home',
  'utensils',
  'car',
  'plug',
  'heart-pulse',
  'film',
  'shopping-bag',
  'circle-ellipsis',
  'briefcase',
  'laptop',
  'gift',
  'piggy-bank',
  'wallet',
  'graduation-cap',
  'plane',
  'baby',
  'paw-print',
  'dumbbell',
  'smartphone',
  'book',
  'coffee',
  'tag',
] as const;
export type CategoryIcon = (typeof CATEGORY_ICONS)[number];

export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

export const MAX_NOTE_LENGTH = 500;
export const MAX_CATEGORY_NAME_LENGTH = 50;

/** True when `value` is a real calendar date in `YYYY-MM-DD` form. */
export function isValidIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export const kindSchema = z.enum(KINDS);
export const idSchema = z.uuid();
export const isoDateSchema = z
  .string()
  .trim()
  .refine(isValidIsoDate, { message: 'Expected a valid date in YYYY-MM-DD format' });
export const timestampSchema = z.iso.datetime({ offset: false });
export const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, { message: 'Expected a 3-letter uppercase ISO 4217 code' })
  .refine(isSupportedCurrency, { message: 'Unsupported currency' });
export const amountMinorSchema = z.number().int().positive().max(MAX_AMOUNT_MINOR);
export const colorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, { message: 'Expected #RRGGBB' });
export const iconSchema = z.enum(CATEGORY_ICONS);
export const noteSchema = z.string().trim().max(MAX_NOTE_LENGTH);
export const categoryNameSchema = z.string().trim().min(1).max(MAX_CATEGORY_NAME_LENGTH);

const syncColumns = {
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deletedAt: timestampSchema.nullable(),
};

// ---- Category ----
export const categorySchema = z.object({
  id: idSchema,
  name: categoryNameSchema,
  kind: kindSchema,
  color: colorSchema,
  icon: iconSchema,
  sortOrder: z.number().int().min(0),
  ...syncColumns,
});
export type Category = z.infer<typeof categorySchema>;

export const newCategorySchema = z.object({
  name: categoryNameSchema,
  kind: kindSchema,
  color: colorSchema,
  icon: iconSchema,
  sortOrder: z.number().int().min(0).optional(),
});
export type NewCategory = z.input<typeof newCategorySchema>;

export const categoryPatchSchema = newCategorySchema.partial();
export type CategoryPatch = z.input<typeof categoryPatchSchema>;

// ---- Transaction ----
export const transactionSchema = z.object({
  id: idSchema,
  kind: kindSchema,
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  categoryId: idSchema,
  date: isoDateSchema,
  note: noteSchema,
  ...syncColumns,
});
export type Transaction = z.infer<typeof transactionSchema>;

export const newTransactionSchema = z.object({
  /** Optional client-provided id (CSV import with ids); generated when absent. */
  id: idSchema.optional(),
  kind: kindSchema,
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  categoryId: idSchema,
  date: isoDateSchema,
  note: noteSchema.default(''),
});
export type NewTransaction = z.input<typeof newTransactionSchema>;
export type ParsedNewTransaction = z.output<typeof newTransactionSchema>;

// `note` is re-declared without its default: a partial patch must never reset an omitted note.
export const transactionPatchSchema = newTransactionSchema
  .omit({ id: true, note: true })
  .partial()
  .extend({ note: noteSchema.optional() });
export type TransactionPatch = z.input<typeof transactionPatchSchema>;

/** Rejects a transaction whose category does not exist, is deleted, or has a different kind. */
export function assertCategoryMatches(
  tx: { kind: Kind; categoryId: string },
  category: Pick<Category, 'id' | 'kind' | 'deletedAt'> | null | undefined,
): void {
  if (!category || category.deletedAt !== null || category.id !== tx.categoryId) {
    throw new DomainError('CATEGORY_NOT_FOUND');
  }
  if (category.kind !== tx.kind) throw new DomainError('CATEGORY_KIND_MISMATCH');
}

/**
 * Schema for a new transaction validated against the known categories (forms, CSV import).
 * Adds a `categoryId` issue when the category is unknown or its kind differs.
 */
export function newTransactionWithCategorySchema(
  categories: ReadonlyMap<string, Pick<Category, 'id' | 'kind' | 'deletedAt'>>,
) {
  return newTransactionSchema.superRefine((tx, ctx) => {
    const category = categories.get(tx.categoryId);
    if (!category || category.deletedAt !== null) {
      ctx.addIssue({ code: 'custom', path: ['categoryId'], message: 'CATEGORY_NOT_FOUND' });
    } else if (category.kind !== tx.kind) {
      ctx.addIssue({ code: 'custom', path: ['categoryId'], message: 'CATEGORY_KIND_MISMATCH' });
    }
  });
}

// ---- Settings ----
/** Cloud backups kept per provider (BUILD_PLAN 3.1). */
export const DEFAULT_BACKUP_RETENTION = 10;
export const MAX_BACKUP_RETENTION = 100;

export const settingsSchema = z.object({
  baseCurrency: currencySchema,
  locale: z.string().trim().min(2).max(35),
  theme: z.enum(THEMES),
  autoLockMinutes: z.number().int().min(1).max(120),
  // Added after backup format v1: older backups and vaults lack it, so it has a default.
  backupRetention: z
    .number()
    .int()
    .min(1)
    .max(MAX_BACKUP_RETENTION)
    .default(DEFAULT_BACKUP_RETENTION),
  // Backup reminders (BUILD_PLAN 3.5); defaults keep older vaults and backups valid.
  backupFrequency: z.enum(BACKUP_FREQUENCIES).default('weekly'),
  /** Last successful backup on this device (cloud upload or file download), ISO 8601. */
  lastBackupAt: z.iso.datetime({ offset: true }).nullable().default(null),
  schemaVersion: z.number().int().min(0),
});
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsKey = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  baseCurrency: 'EUR',
  locale: 'en',
  theme: 'system',
  autoLockMinutes: 5,
  backupRetention: DEFAULT_BACKUP_RETENTION,
  backupFrequency: 'weekly',
  lastBackupAt: null,
  schemaVersion: 0,
};

// ---- Query ----
export const SORT_KEYS = ['date', 'amount', 'category', 'kind'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 50;

export const transactionQuerySchema = z
  .object({
    kind: kindSchema.optional(),
    categoryIds: z.array(idSchema).max(500).optional(),
    dateFrom: isoDateSchema.optional(),
    dateTo: isoDateSchema.optional(),
    search: z.string().trim().max(200).optional(),
    sortBy: z.enum(SORT_KEYS).default('date'),
    sortDir: z.enum(['asc', 'desc']).default('desc'),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    offset: z.number().int().min(0).default(0),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
    message: 'dateFrom must not be after dateTo',
    path: ['dateTo'],
  });
export type TransactionQuery = z.input<typeof transactionQuerySchema>;
export type ParsedTransactionQuery = z.output<typeof transactionQuerySchema>;

export const dateRangeSchema = z
  .object({ dateFrom: isoDateSchema, dateTo: isoDateSchema })
  .refine((r) => r.dateFrom <= r.dateTo, { message: 'dateFrom must not be after dateTo' });
export type DateRange = z.infer<typeof dateRangeSchema>;
