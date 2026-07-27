import type { PresentationSemanticIconKey } from "@esbla/contracts";
import {
  Bell,
  Boxes,
  BriefcaseBusiness,
  CalendarCheck,
  CalendarRange,
  CheckSquare,
  Circle,
  Clock3,
  Contrast,
  Diamond,
  Home,
  ListChecks,
  type LucideIcon,
  type LucideProps,
  Maximize2,
  Menu,
  Moon,
  Pencil,
  Plus,
  ReceiptText,
  Search,
  Settings,
  Sun,
  TriangleAlert,
  User,
  UserRound,
  Users,
  UsersRound,
  X,
} from "lucide-react";
import { createElement } from "react";

const SEMANTIC_ICON_COMPONENTS = Object.freeze({
  bell: Bell,
  "briefcase-business": BriefcaseBusiness,
  "calendar-check": CalendarCheck,
  "calendar-range": CalendarRange,
  "check-square": CheckSquare,
  "clock-3": Clock3,
  contrast: Contrast,
  diamond: Diamond,
  edit: Pencil,
  fullscreen: Maximize2,
  "generic-service": Circle,
  home: Home,
  "list-checks": ListChecks,
  moon: Moon,
  menu: Menu,
  modules: Boxes,
  plus: Plus,
  "receipt-text": ReceiptText,
  search: Search,
  settings: Settings,
  sun: Sun,
  team: Users,
  user: User,
  "user-round": UserRound,
  "users-round": UsersRound,
  warning: TriangleAlert,
  x: X,
}) satisfies Readonly<Record<PresentationSemanticIconKey, LucideIcon>>;

export function resolveSemanticIcon(value: unknown): LucideIcon {
  if (typeof value !== "string") return SEMANTIC_ICON_COMPONENTS["generic-service"];
  return (
    SEMANTIC_ICON_COMPONENTS[value as PresentationSemanticIconKey] ??
    SEMANTIC_ICON_COMPONENTS["generic-service"]
  );
}

export function SemanticIcon({
  semanticKey,
  ...props
}: LucideProps & { readonly semanticKey: unknown }) {
  const Icon = resolveSemanticIcon(semanticKey);
  return createElement(Icon, props);
}
