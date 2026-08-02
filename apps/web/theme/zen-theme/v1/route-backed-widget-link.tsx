import Link from "next/link";
import type { ReactNode } from "react";
import {
  buildNestedRouteBackedWidgetHref,
  type RouteBackedWidgetOrigin,
} from "../../../lib/route-backed-widget-navigation-core";

export function RouteBackedWidgetLink({
  ariaCurrent,
  children,
  className,
  focusHref,
  focusOrigin,
  href,
}: Readonly<{
  ariaCurrent?: "page" | undefined;
  children: ReactNode;
  className: string;
  focusHref?: string | undefined;
  focusOrigin?: RouteBackedWidgetOrigin | undefined;
  href: string;
}>) {
  if (!focusOrigin) {
    return (
      <a aria-current={ariaCurrent} className={className} href={href}>
        {children}
      </a>
    );
  }
  return (
    <Link
      aria-current={ariaCurrent}
      className={className}
      href={buildNestedRouteBackedWidgetHref(focusHref ?? href, focusOrigin)}
    >
      {children}
    </Link>
  );
}
