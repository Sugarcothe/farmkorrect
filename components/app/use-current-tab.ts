"use client";

import { usePathname } from "next/navigation";
import type { NavTab } from "@/lib/profile/config";

/** The tab the current address belongs to, shared by the bottom nav and the sidebar. */
export function useCurrentTab(tabs: readonly NavTab[]): { pathname: string; current: string | undefined } {
  const pathname = usePathname();
  // the most specific match wins, so /services/jobs lights up Jobs, not Services
  const current = tabs
    .map((tab) => tab.href)
    .filter((href): href is string => href !== null && (pathname === href || pathname.startsWith(`${href}/`)))
    .sort((x, y) => y.length - x.length)[0];
  return { pathname, current };
}
