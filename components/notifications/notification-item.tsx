"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icons";
import { formatDate } from "@/components/wallet/wallet-parts";
import { markNotificationRead } from "@/lib/notifications/api";
import { NOTIFICATION_TYPES, safeInternalPath, type Notification } from "@/lib/notifications/types";
import { setUnreadCount } from "@/lib/notifications/unread-store";

/**
 * One inbox entry. Opening its link marks it read first; the toggle marks it
 * read or unread. The read state shown is what the server stored — on an
 * error it stays as it was and says so.
 */
export function NotificationItem({ notification }: { notification: Notification }) {
  const router = useRouter();
  const [readAt, setReadAt] = useState(notification.readAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unread = readAt === null;
  const href = safeInternalPath(notification.url);
  const icon = NOTIFICATION_TYPES[notification.type]?.icon ?? "bell";

  async function setRead(read: boolean) {
    if (busy) return false;
    setBusy(true);
    setError(null);
    const result = await markNotificationRead(notification.id, read);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setReadAt(result.data.notification.readAt);
    setUnreadCount(result.data.unreadCount);
    return true;
  }

  async function open() {
    if (!href) return;
    if (unread) await setRead(true);
    router.push(href);
  }

  const text = (
    <>
      <span className="flex items-center gap-2">
        <span className={`truncate text-sm ${unread ? "font-semibold text-foreground" : "font-medium text-foreground/80"}`}>
          {notification.title}
        </span>
        {unread && (
          <>
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-primary" />
            <span className="sr-only">(unread)</span>
          </>
        )}
      </span>
      <span className={`mt-0.5 block text-sm leading-snug ${unread ? "text-foreground/75" : "text-muted-foreground"}`}>
        {notification.body}
      </span>
      <time dateTime={notification.createdAt} className="mt-1 block text-xs text-muted-foreground">
        {formatDate(notification.createdAt, true)}
      </time>
    </>
  );

  return (
    <li className={`flex gap-3 px-4 py-4 ${unread ? "bg-primary/[0.03]" : ""}`}>
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${
          unread ? "bg-primary/10 text-primary" : "bg-foreground/5 text-foreground/50"
        }`}
      >
        <Icon name={icon} className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        {href ? (
          <a
            href={href}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              void open();
            }}
            className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {text}
          </a>
        ) : (
          <div>{text}</div>
        )}
        {error && (
          <p role="alert" className="mt-1.5 text-xs text-red-700">
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => void setRead(unread)}
        disabled={busy}
        aria-busy={busy || undefined}
        aria-label={unread ? `Mark "${notification.title}" as read` : `Mark "${notification.title}" as unread`}
        title={unread ? "Mark as read" : "Mark as unread"}
        className="flex size-9 shrink-0 items-center justify-center self-start rounded-full text-foreground/45 outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
      >
        <Icon name={unread ? "check" : "mail"} className="size-[18px]" />
      </button>
    </li>
  );
}

