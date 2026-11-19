"use client";

import Image from "next/image";
import Link from "next/link";
import { Icon, type IconName } from "@/components/ui/icons";
import { useUnreadCount } from "@/lib/notifications/unread-store";
import type { NavTab } from "@/lib/profile/config";
import { SITE } from "@/lib/site";
import { useCurrentTab } from "./use-current-tab";

const itemClass =
  "relative flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent";

function NavItem({
  href,
  icon,
  label,
  active,
  badge,
}: {
  href: string;
  icon: IconName;
  label: string;
  active: boolean;
  badge?: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`${itemClass} ${active ? "bg-primary/8 text-primary" : "text-foreground/70 hover:bg-foreground/5 hover:text-foreground"}`}
    >
      <Icon name={icon} className="size-5" />
      <span className="flex-1">{label}</span>
      {badge && (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[0.6875rem] leading-none font-semibold text-white">
          {badge}
        </span>
      )}
    </Link>
  );
}

/**
 * Desktop navigation: the same role tabs as the bottom nav, as a sidebar.
 * Shown from the lg breakpoint; below it the bottom nav takes over.
 */
export function SideNav({ tabs, name, roleTitle }: { tabs: readonly NavTab[]; name: string; roleTitle: string }) {
  const { pathname, current } = useCurrentTab(tabs);
  const unread = useUnreadCount() ?? 0;
  const onNotifications = pathname === "/notifications" || pathname.startsWith("/notifications/");

  return (
    <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-foreground/8 bg-white lg:flex">
      <Link
        href="/home"
        className="flex h-16 shrink-0 items-center gap-2.5 px-5 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      >
        <span className="relative size-9 shrink-0">
          <Image src="/farm-korret-logo.png" alt="" fill sizes="36px" />
        </span>
        <span className="text-base font-semibold text-primary">{SITE.shortName}</span>
      </Link>

      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-2">
        <ul className="space-y-1">
          {tabs.map((tab) => (
            <li key={tab.label}>
              {tab.href ? (
                <NavItem href={tab.href} icon={tab.icon} label={tab.label} active={tab.href === current} />
              ) : (
                <span
                  aria-disabled="true"
                  title={`${tab.label} is coming soon`}
                  className={`${itemClass} cursor-not-allowed text-foreground/30`}
                >
                  <Icon name={tab.icon} className="size-5" />
                  <span className="flex-1">{tab.label}</span>
                  <span className="rounded-full bg-foreground/8 px-1.5 text-[0.625rem] leading-tight font-semibold text-foreground/50">
                    Soon
                  </span>
                  <span className="sr-only">(coming soon)</span>
                </span>
              )}
            </li>
          ))}
          <li>
            <NavItem
              href="/notifications"
              icon="bell"
              label="Notifications"
              active={onNotifications}
              badge={unread > 0 ? (unread > 99 ? "99+" : String(unread)) : undefined}
            />
          </li>
        </ul>
      </nav>

      <Link
        href="/profile"
        className="m-3 flex items-center gap-3 rounded-2xl bg-surface px-3 py-3 outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
          {name.charAt(0).toUpperCase() || "?"}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">{roleTitle}</span>
        </span>
      </Link>
    </aside>
  );
}
