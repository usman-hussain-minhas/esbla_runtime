export type ZenResponsiveBreakpoint = "desktop" | "phone" | "tablet";
export type ZenResponsiveOptionalControl =
  | "appearance"
  | "contextual"
  | "notifications"
  | "service-groups"
  | "settings";

export interface ZenResponsiveChromeInput {
  readonly availableInlineSize: number;
  readonly buttonInlineSize: number;
  readonly clusterGap: number;
  readonly controlGap: number;
  readonly endInset: number;
  readonly hasAppearance: boolean;
  readonly hasContextualMenu: boolean;
  readonly hasNotifications: boolean;
  readonly hasSettings: boolean;
  readonly hasServiceGroups: boolean;
  readonly startInset: number;
}

export interface ZenResponsiveChromeResult {
  readonly breakpoint: ZenResponsiveBreakpoint;
  readonly collapsed: readonly ZenResponsiveOptionalControl[];
  readonly direct: readonly ZenResponsiveOptionalControl[];
  readonly systemRequired: boolean;
}

const canonicalDirectOrder = [
  "contextual",
  "service-groups",
  "notifications",
  "appearance",
  "settings",
] as const;
const failClosedCollapseOrder = [
  "notifications",
  "appearance",
  "settings",
  "service-groups",
  "contextual",
] as const;

function isValidDimension(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function breakpointFor(availableInlineSize: number): ZenResponsiveBreakpoint {
  if (availableInlineSize >= 1_100) return "desktop";
  if (availableInlineSize >= 768) return "tablet";
  return "phone";
}

function requiredInlineSize(
  input: ZenResponsiveChromeInput,
  direct: ReadonlySet<ZenResponsiveOptionalControl>,
  systemRequired: boolean,
): number {
  const leftControlCount =
    1 + Number(direct.has("service-groups")) + Number(direct.has("contextual"));
  const rightControlCount =
    Number(systemRequired) +
    Number(direct.has("notifications")) +
    Number(direct.has("appearance")) +
    Number(direct.has("settings"));
  const leftWidth =
    leftControlCount * input.buttonInlineSize +
    Math.max(0, leftControlCount - 1) * input.controlGap;
  const rightWidth =
    rightControlCount * input.buttonInlineSize +
    Math.max(0, rightControlCount - 1) * input.controlGap;
  return (
    input.startInset +
    leftWidth +
    (rightControlCount > 0 ? input.clusterGap + rightWidth : 0) +
    input.endInset
  );
}

function presentControls(input: ZenResponsiveChromeInput): ZenResponsiveOptionalControl[] {
  return canonicalDirectOrder.filter((control) => {
    if (control === "appearance") return input.hasAppearance;
    if (control === "contextual") return input.hasContextualMenu;
    if (control === "notifications") return input.hasNotifications;
    if (control === "settings") return input.hasSettings;
    return input.hasServiceGroups;
  });
}

export function resolveZenResponsiveChrome(
  input: ZenResponsiveChromeInput,
): ZenResponsiveChromeResult {
  const present = presentControls(input);
  const dimensions = [
    input.availableInlineSize,
    input.buttonInlineSize,
    input.clusterGap,
    input.controlGap,
    input.endInset,
    input.startInset,
  ];
  if (
    dimensions.some((value) => !isValidDimension(value)) ||
    input.availableInlineSize === 0 ||
    input.buttonInlineSize === 0
  ) {
    return {
      breakpoint: "phone",
      collapsed: failClosedCollapseOrder.filter((control) => present.includes(control)),
      direct: [],
      systemRequired: present.length > 0,
    };
  }

  const breakpoint = breakpointFor(input.availableInlineSize);
  if (breakpoint === "desktop") {
    return {
      breakpoint,
      collapsed: [],
      direct: present,
      systemRequired: input.hasAppearance || input.hasNotifications || input.hasSettings,
    };
  }

  const direct = new Set<ZenResponsiveOptionalControl>(present);
  const collapsed: ZenResponsiveOptionalControl[] = [];
  const collapseOrder: readonly ZenResponsiveOptionalControl[] =
    breakpoint === "phone"
      ? ["notifications", "appearance", "settings", "service-groups", "contextual"]
      : ["notifications", "appearance", "settings", "contextual", "service-groups"];

  if (breakpoint === "phone" && direct.delete("notifications")) collapsed.push("notifications");
  if (breakpoint === "phone" && direct.delete("appearance")) collapsed.push("appearance");
  if (breakpoint === "phone" && direct.delete("settings")) collapsed.push("settings");

  let systemRequired =
    input.hasAppearance || input.hasNotifications || input.hasSettings || collapsed.length > 0;
  for (const control of collapseOrder) {
    if (requiredInlineSize(input, direct, systemRequired) <= input.availableInlineSize) break;
    if (!direct.delete(control)) continue;
    collapsed.push(control);
    systemRequired = true;
  }

  return {
    breakpoint,
    collapsed,
    direct: canonicalDirectOrder.filter((control) => direct.has(control)),
    systemRequired,
  };
}
