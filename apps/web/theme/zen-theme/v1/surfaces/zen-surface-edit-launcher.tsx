"use client";

import { Pencil } from "lucide-react";
import Link from "next/link";
import { prepareRouteHeadingFocus } from "../chrome/zen-navigation-chrome";

export interface ZenSurfaceEditDescriptor {
  readonly ariaLabel: string;
  readonly href:
    | "/studio/surfaces/surface.hr.mission-control/personal"
    | "/studio/surfaces/surface.mission-control/personal";
  readonly route: "/" | "/workspace/hr";
}

export function ZenSurfaceEditLauncher({
  ariaLabel,
  href,
}: Readonly<Pick<ZenSurfaceEditDescriptor, "ariaLabel" | "href">>) {
  return (
    <Link
      aria-label={ariaLabel}
      className="chrome-button surface-edit-launcher"
      data-tooltip={ariaLabel}
      href={href}
      onClick={prepareRouteHeadingFocus}
      title="Edit personal layout"
    >
      <Pencil aria-hidden="true" size={17} />
    </Link>
  );
}
