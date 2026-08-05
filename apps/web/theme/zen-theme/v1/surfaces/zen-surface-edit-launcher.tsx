"use client";

import { Pencil } from "lucide-react";
import Link from "next/link";
import type { ZenSurfaceEditDescriptor } from "../../../../lib/zen-surface-edit-core";
import { prepareRouteHeadingFocus } from "../chrome/zen-navigation-chrome";

export type { ZenSurfaceEditDescriptor } from "../../../../lib/zen-surface-edit-core";

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
