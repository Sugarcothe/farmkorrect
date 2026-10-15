"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/icons";
import type { NavTab } from "@/lib/profile/config";

/** Hidden on full-screen forms, which have their own Cancel/Save actions. */
const HIDDEN_ON = [
  /^\/profile\/edit(\/|$)/,
  /^\/profile\/services\/(new|[^/]+\/edit)\/?$/,
  /^\/profile\/bank-details\/setup\/?$/,
];

export function BottomNav({ tabs }: { tabs: readonly NavTab[] }) {
  const pathname = usePathname();
  if (HIDDEN_ON.some((pattern) => pattern.test(pathname))) return null;

  return (
    <nav
      aria-label="Main"
      className="sticky bottom-0 z-10 shrink-0 border-t border-foreground/8 bg-white pb-[env(safe-area-inset-bottom)] md:pb-0"
    >
      <ul className="grid grid-cols-5">
        {tabs.map((tab) => {
          const active = tab.href !== null && (pathname === tab.href || pathname.startsWith(`${tab.href}/`));
          const content = (
            <>
              <Icon name={tab.icon} className="size-[22px]" />
              <span className="text-[0.6875rem] leading-none font-medium">{tab.label}</span>
            </>
          );
          return (
            <li key={tab.label}>
              {tab.href ? (
                <Link
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex h-16 flex-col items-center justify-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
                    active ? "text-primary" : "text-foreground/50 hover:text-foreground"
                  }`}
                >
                  {content}
                </Link>
              ) : (
                <span
                  aria-disabled="true"
                  title={`${tab.label} is coming soon`}
                  className="relative flex h-16 cursor-not-allowed flex-col items-center justify-center gap-1.5 text-foreground/30"
                >
                  {content}
                  <span className="absolute top-1.5 right-1/2 translate-x-[1.35rem] rounded-full bg-foreground/8 px-1 text-[0.5625rem] leading-tight font-semibold text-foreground/50">
                    Soon
                  </span>
                  <span className="sr-only">(coming soon)</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
