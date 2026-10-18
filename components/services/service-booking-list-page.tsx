import Link from "next/link";
import { redirect } from "next/navigation";
import { ProfileTopBar } from "@/components/profile/profile-parts";
import { buttonClasses } from "@/components/ui/button";
import { EmptyList, first, ListCard, Pager } from "@/components/wallet/wallet-parts";
import { HttpError } from "@/lib/server/http";
import type { UserDoc } from "@/lib/server/models";
import { listServiceBookings } from "@/lib/server/service-bookings";
import { ServiceBookingRow } from "./service-parts";

const COPY = {
  customer: {
    title: "My service bookings",
    path: "/services/bookings",
    item: "/services/bookings",
    label: "Services you booked",
    emptyTitle: "No service bookings yet",
    empty: "Book a service from the Services directory and it will show here.",
  },
  provider: {
    title: "Service jobs",
    path: "/services/jobs",
    item: "/services/jobs",
    label: "Services booked with you",
    emptyTitle: "No jobs yet",
    empty: "Bookings for the services you list will show here.",
  },
} as const;

/**
 * A user's service bookings (as customer) or jobs (as provider), newest
 * first. Paged with the server's keyset cursor; a bad cursor starts again.
 */
export async function ServiceBookingListPage({
  user,
  view,
  cursorParam,
}: {
  user: UserDoc;
  view: "customer" | "provider";
  cursorParam: string | string[] | undefined;
}) {
  const copy = COPY[view];
  const cursor = first(cursorParam) ?? null;
  let page;
  try {
    page = await listServiceBookings(user, view, cursor);
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) redirect(copy.path);
    throw error;
  }

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title={copy.title} />
      <div className="flex-1 px-5 pb-8">
        {view === "customer" && (
          <Link href="/services" className={buttonClasses("outline", "mb-4")}>
            Browse services
          </Link>
        )}
        {view === "provider" && (
          <Link href="/profile/services" className={buttonClasses("outline", "mb-4")}>
            Manage my services
          </Link>
        )}
        {page.bookings.length === 0 ? (
          <EmptyList
            icon={view === "provider" ? "briefcase" : "calendar"}
            title={cursor ? "No older bookings" : copy.emptyTitle}
          >
            {cursor ? "You've reached the end of the list." : copy.empty}
          </EmptyList>
        ) : (
          <ListCard label={copy.label}>
            {page.bookings.map((b) => (
              <ServiceBookingRow key={b.id} booking={b} href={`${copy.item}/${b.id}`} />
            ))}
          </ListCard>
        )}
        <Pager
          newer={cursor ? copy.path : null}
          older={page.nextCursor ? `${copy.path}?cursor=${encodeURIComponent(page.nextCursor)}` : null}
        />
      </div>
    </main>
  );
}
