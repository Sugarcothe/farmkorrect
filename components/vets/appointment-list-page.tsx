import Link from "next/link";
import { redirect } from "next/navigation";
import { ProfileTopBar } from "@/components/profile/profile-parts";
import { buttonClasses } from "@/components/ui/button";
import { EmptyList, first, ListCard, Pager } from "@/components/wallet/wallet-parts";
import { listAppointments } from "@/lib/server/appointments";
import { HttpError } from "@/lib/server/http";
import type { UserDoc } from "@/lib/server/models";
import { AppointmentRow } from "./vet-parts";

const COPY = {
  customer: {
    title: "My appointments",
    path: "/appointments",
    label: "Your vet appointments",
    emptyTitle: "No appointments yet",
    empty: "Book a vet visit from Find a Vet and it will show here.",
  },
  vet: {
    title: "Jobs",
    path: "/jobs",
    label: "Appointments booked with you",
    emptyTitle: "No jobs yet",
    empty: "Requests from customers will show here once you're listed in Find a Vet.",
  },
} as const;

/**
 * A user's appointments (as customer) or jobs (as vet), newest first. Paged
 * with the server's keyset cursor; a bad or stale cursor starts the list again.
 */
export async function AppointmentListPage({
  user,
  view,
  cursorParam,
}: {
  user: UserDoc;
  view: "customer" | "vet";
  cursorParam: string | string[] | undefined;
}) {
  const copy = COPY[view];
  const cursor = first(cursorParam) ?? null;
  let page;
  try {
    page = await listAppointments(user, view, cursor);
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) redirect(copy.path);
    throw error;
  }

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title={copy.title} />
      <div className="flex-1 px-5 pb-8">
        {view === "customer" && (
          <Link href="/vets" className={buttonClasses("outline", "mb-4")}>
            Find a vet
          </Link>
        )}
        {page.appointments.length === 0 ? (
          <EmptyList icon={view === "vet" ? "briefcase" : "calendar"} title={cursor ? "No older appointments" : copy.emptyTitle}>
            {cursor ? "You've reached the end of the list." : copy.empty}
          </EmptyList>
        ) : (
          <ListCard label={copy.label}>
            {page.appointments.map((a) => (
              <AppointmentRow key={a.id} appointment={a} href={`/appointments/${a.id}`} />
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
