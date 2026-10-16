import Link from "next/link";
import { NOTIFICATION_CATEGORIES, type NotificationCategory, type NotificationFilter } from "@/lib/notifications/types";

/** Link to a page of the inbox, keeping the current filters. */
export function inboxHref(filter: NotificationFilter, category: NotificationCategory | null, page = 1) {
  const params = new URLSearchParams();
  if (filter === "unread") params.set("filter", "unread");
  if (category) params.set("category", category);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/notifications?${query}` : "/notifications";
}

const chip = (active: boolean) =>
  `flex h-8 shrink-0 items-center rounded-full px-3.5 text-[0.8125rem] font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-accent ${
    active ? "bg-primary text-primary-foreground" : "bg-white text-foreground/70 ring-1 ring-foreground/8 hover:text-foreground"
  }`;

/** All / Unread tabs and category chips. Plain links, so they work without JavaScript. */
export function InboxFilters({ filter, category }: { filter: NotificationFilter; category: NotificationCategory | null }) {
  return (
    <div className="mb-4 space-y-3">
      <nav aria-label="Show" className="grid grid-cols-2 gap-1 rounded-full bg-foreground/5 p-1">
        {(["all", "unread"] as const).map((value) => (
          <Link
            key={value}
            href={inboxHref(value, category)}
            aria-current={filter === value ? "page" : undefined}
            className={`flex h-9 items-center justify-center rounded-full text-[0.8125rem] font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              filter === value ? "bg-white text-primary shadow-sm" : "text-foreground/60 hover:text-foreground"
            }`}
          >
            {value === "all" ? "All" : "Unread"}
          </Link>
        ))}
      </nav>
      <nav aria-label="Category" className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1">
        <Link href={inboxHref(filter, null)} aria-current={category === null ? "page" : undefined} className={chip(category === null)}>
          Everything
        </Link>
        {NOTIFICATION_CATEGORIES.map((c) => (
          <Link
            key={c.value}
            href={inboxHref(filter, c.value)}
            aria-current={category === c.value ? "page" : undefined}
            className={chip(category === c.value)}
          >
            {c.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
