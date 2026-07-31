"use client";

import { Pencil } from "lucide-react";
import Link from "next/link";
import { prepareRouteHeadingFocus } from "../chrome/zen-navigation-chrome";

export function ZenSurfaceEditLauncher({
  ariaLabel,
  href,
}: Readonly<{
  ariaLabel: string;
  href:
    | "/studio/surfaces/surface.hr.mission-control/personal"
    | "/studio/surfaces/surface.mission-control/personal";
}>) {
  return (
    <Link
      aria-label={ariaLabel}
      className="surface-edit-launcher"
      href={href}
      onClick={prepareRouteHeadingFocus}
      title="Edit personal layout"
    >
      <Pencil aria-hidden="true" size={17} />
    </Link>
  );
}
