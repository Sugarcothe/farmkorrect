import type { Metadata } from "next";
import Link from "next/link";
import { pageNumber } from "@/components/orders/order-list-page";
import { inboxHref, InboxFilters } from "@/components/notifications/inbox-filters";
import { MarkAllRead } from "@/components/notifications/mark-all-read";
import { UnreadCountSync } from "@/components/notifications/notification-bell";
import { NotificationItem } from "@/components/notifications/notification-item";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { Icon } from "@/components/ui/icons";
import { EmptyList, first, Pager } from "@/components/wallet/wallet-parts";
import { isNotificationCategory } from "@/lib/notifications/types";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { listNotifications } from "@/lib/server/notifications";

export const metadata: Metadata = { title: "Notifications" };

// The signed-in user's inbox, newest first, read from the database. Unknown
// filter values in the address fall back to showing everything.
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const params = await searchParams;
  const filter = first(params.filter) === "unread" ? "unread" : "all";
  const categoryParam = first(params.category);
  const category = isNotificationCategory(categoryParam) ? categoryParam : null;
  const page = pageNumber(params.page);
  const { notifications, hasMore, unreadCount } = await listNotifications(user._id, { filter, category, page });
  const filtered = filter === "unread" || category !== null;

  return (
    <main className="flex flex-1 flex-col">
      <UnreadCountSync count={unreadCount} />
      <ProfileTopBar
        title="Notifications"
        back={<BackLink href="/profile" />}
        action={
          <Link
            href="/profile/notifications"
            aria-label="Notification settings"
            className="flex size-10 items-center justify-center rounded-full outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon name="pencil" className="size-[18px]" />
          </Link>
        }
      />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <InboxFilters filter={filter} category={category} />
        {unreadCount > 0 && <MarkAllRead />}
        {notifications.length === 0 ? (
          page > 1 ? (
            <EmptyList icon="bell" title="Nothing on this page">
              <Link href={inboxHref(filter, category)} className="font-medium text-primary">
                Back to your latest notifications
              </Link>
            </EmptyList>
          ) : filtered ? (
            <EmptyList icon="bell" title={filter === "unread" ? "You're all caught up" : "Nothing here yet"}>
              {filter === "unread" ? "There are no unread notifications here." : "No notifications in this category yet."}{" "}
              <Link href="/notifications" className="font-medium text-primary">
                Show everything
              </Link>
            </EmptyList>
          ) : (
            <EmptyList icon="bell" title="No notifications yet">
              Updates about your orders, payments, payouts and account will appear here.
            </EmptyList>
          )
        ) : (
          <ul aria-label="Notifications" className="divide-y divide-foreground/6 overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-foreground/5">
            {notifications.map((notification) => (
              <NotificationItem key={`${notification.id}:${notification.readAt ?? ""}`} notification={notification} />
            ))}
          </ul>
        )}
        <Pager
          newer={page > 1 ? inboxHref(filter, category, page - 1) : null}
          older={hasMore ? inboxHref(filter, category, page + 1) : null}
        />
      </div>
    </main>
  );
}
