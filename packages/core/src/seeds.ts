import type { CategoryIcon, Kind } from './domain';

export interface CategorySeed {
  name: string;
  kind: Kind;
  color: string;
  icon: CategoryIcon;
  sortOrder: number;
}

const expense: Array<[string, string, CategoryIcon]> = [
  ['Housing', '#0f766e', 'home'],
  ['Food', '#ea580c', 'utensils'],
  ['Transport', '#2563eb', 'car'],
  ['Utilities', '#ca8a04', 'plug'],
  ['Health', '#dc2626', 'heart-pulse'],
  ['Entertainment', '#9333ea', 'film'],
  ['Shopping', '#db2777', 'shopping-bag'],
  ['Other', '#64748b', 'circle-ellipsis'],
];

const income: Array<[string, string, CategoryIcon]> = [
  ['Salary', '#16a34a', 'briefcase'],
  ['Freelance', '#0891b2', 'laptop'],
  ['Gifts', '#c026d3', 'gift'],
  ['Interest', '#65a30d', 'piggy-bank'],
  ['Other', '#64748b', 'circle-ellipsis'],
];

/** Default categories seeded on first run (BUILD_PLAN §4.2). */
export const DEFAULT_CATEGORY_SEEDS: readonly CategorySeed[] = [
  ...expense.map(([name, color, icon], i) => ({
    name,
    kind: 'expense' as const,
    color,
    icon,
    sortOrder: i,
  })),
  ...income.map(([name, color, icon], i) => ({
    name,
    kind: 'income' as const,
    color,
    icon,
    sortOrder: i,
  })),
];
