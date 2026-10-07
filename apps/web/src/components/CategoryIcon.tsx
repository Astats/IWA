import type { CategoryIcon as IconKey } from '@budget/core';
import {
  Baby,
  Book,
  Briefcase,
  Car,
  CircleEllipsis,
  Coffee,
  Dumbbell,
  Film,
  Gift,
  GraduationCap,
  HeartPulse,
  Home,
  Laptop,
  PawPrint,
  PiggyBank,
  Plane,
  Plug,
  ShoppingBag,
  Smartphone,
  Tag,
  Utensils,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

/** Maps the fixed icon allow-list (BUILD_PLAN §4.1) to icon components. */
export const CATEGORY_ICON_COMPONENTS: Record<IconKey, LucideIcon> = {
  home: Home,
  utensils: Utensils,
  car: Car,
  plug: Plug,
  'heart-pulse': HeartPulse,
  film: Film,
  'shopping-bag': ShoppingBag,
  'circle-ellipsis': CircleEllipsis,
  briefcase: Briefcase,
  laptop: Laptop,
  gift: Gift,
  'piggy-bank': PiggyBank,
  wallet: Wallet,
  'graduation-cap': GraduationCap,
  plane: Plane,
  baby: Baby,
  'paw-print': PawPrint,
  dumbbell: Dumbbell,
  smartphone: Smartphone,
  book: Book,
  coffee: Coffee,
  tag: Tag,
};

/** Decorative category icon on a colored badge. Color comes from validated `#RRGGBB` data. */
export function CategoryIcon({
  icon,
  color,
  className,
}: {
  icon: IconKey;
  color: string;
  className?: string;
}) {
  const Icon = CATEGORY_ICON_COMPONENTS[icon];
  return (
    <span
      aria-hidden
      // CSSOM style property (not an inline style attribute), allowed under style-src 'self'.
      style={{ backgroundColor: color }}
      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full text-white ${className ?? ''}`}
    >
      <Icon className="size-4" />
    </span>
  );
}
