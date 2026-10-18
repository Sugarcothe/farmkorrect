"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icons";
import { backButtonClass } from "@/components/profile/profile-parts";
import { setUnreadCount, useUnreadCount } from "@/lib/notifications/unread-store";

const badgeText = (count: number) => (count > 99 ? "99+" : String(count));

const onPrimaryClass =
  "flex size-10 items-center justify-center rounded-full bg-white/10 text-primary-foreground outline-none hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white";

/**
 * The header bell: opens the inbox and shows how many are unread.
 * `onPrimary` styles it for a green (primary) header.
 */
export function NotificationBell({ onPrimary = false }: { onPrimary?: boolean } = {}) {
  const count = useUnreadCount();
  const unread = count ?? 0;
  const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";
  return (
    <Link href="/notifications" aria-label={label} className={`relative ${onPrimary ? onPrimaryClass : backButtonClass}`}>
      <Icon name="bell" />
      {unread > 0 && (
        <span
          aria-hidden="true"
          className={`absolute top-1 right-0.5 flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-red-600 px-1 text-[0.625rem] leading-none font-semibold text-white ring-2 ${onPrimary ? "ring-primary" : "ring-surface"}`}
        >
          {badgeText(unread)}
        </span>
      )}
    </Link>
  );
}

/** A small dot for the nav tab that leads to notifications. */
export function UnreadDot() {
  const count = useUnreadCount();
  if (!count) return null;
  return (
    <>
      <span aria-hidden="true" className="absolute top-3 right-1/2 size-2 translate-x-3 rounded-full bg-red-600 ring-2 ring-white" />
      <span className="sr-only">({count} unread notifications)</span>
    </>
  );
}

/** Hands the count a server-rendered page already read to the shared store. */
export function UnreadCountSync({ count }: { count: number }) {
  useEffect(() => {
    setUnreadCount(count);
  }, [count]);
  return null;
}
