"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UnreadDot } from "@/components/notifications/notification-bell";
import { Icon } from "@/components/ui/icons";
import type { NavTab } from "@/lib/profile/config";

/** Hidden on full-screen forms, which have their own Cancel/Save actions. */
const HIDDEN_ON = [
  /^\/profile\/edit(\/|$)/,
  /^\/profile\/services\/(new|[^/]+\/edit)\/?$/,
  /^\/profile\/bank-details\/setup\/?$/,
  /^\/wallet\/payout\/?$/,
  /^\/market\/listings\/(new|[^/]+\/edit)\/?$/,
  /^\/vets\/[^/]+\/book\/?$/,
  /^\/services\/[^/]+\/book\/?$/,
  /^\/admin\/training\/[^/]+\/?$/,
];

export function BottomNav({ tabs }: { tabs: readonly NavTab[] }) {
  const pathname = usePathname();
  if (HIDDEN_ON.some((pattern) => pattern.test(pathname))) return null;
  // the most specific match wins, so /services/jobs lights up Jobs, not Services
  const current = tabs
    .map((tab) => tab.href)
    .filter((href): href is string => href !== null && (pathname === href || pathname.startsWith(`${href}/`)))
    .sort((x, y) => y.length - x.length)[0];

  return (
    <nav
      aria-label="Main"
      className="sticky bottom-0 z-10 shrink-0 border-t border-foreground/8 bg-white pb-[env(safe-area-inset-bottom)] md:pb-0"
    >
      <ul className="grid" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((tab) => {
          const active = tab.href !== null && tab.href === current;
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
                  className={`relative flex h-16 flex-col items-center justify-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
                    active ? "text-primary" : "text-foreground/50 hover:text-foreground"
                  }`}
                >
                  {content}
                  {/* notifications live under Profile, so its tab shows when something is unread */}
                  {tab.href === "/profile" && <UnreadDot />}
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
