import Link from "next/link";
import { redirect } from "next/navigation";
import { ProfileTopBar } from "@/components/profile/profile-parts";
import { Icon } from "@/components/ui/icons";
import { EmptyList, first } from "@/components/wallet/wallet-parts";
import { JOB_COUNT_CAP, jobTabCounts, listAppointments } from "@/lib/server/appointments";
import { HttpError } from "@/lib/server/http";
import type { UserDoc } from "@/lib/server/models";
import { isJobTab, JOB_TABS, type JobTab } from "@/lib/vets/types";
import { JobCard } from "./vet-parts";

const EMPTY: Record<JobTab, { title: string; body: string }> = {
  pending: {
    title: "No pending requests",
    body: "New requests from customers will show here for you to accept or decline.",
  },
  active: { title: "No active jobs", body: "Requests you accept show here until the visit is completed." },
  completed: { title: "No completed visits yet", body: "Visits you complete will be kept here." },
  closed: {
    title: "Nothing closed",
    body: "Requests you declined, ones that lapsed and appointments that were cancelled show here.",
  },
};

export const jobsHref = (tab: JobTab, cursor?: string | null) =>
  `/jobs?tab=${tab}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

/**
 * The vet's jobs, split into Pending, Active, Completed and Closed (declined,
 * lapsed and cancelled: never shown as completed). Each tab is filtered and
 * paged on the server, for the session's own vet only. Without a tab, it
 * opens on Pending when something is waiting, otherwise Active.
 */
export async function JobsPage({
  user,
  tabParam,
  cursorParam,
}: {
  user: UserDoc;
  tabParam: string | string[] | undefined;
  cursorParam: string | string[] | undefined;
}) {
  const counts = await jobTabCounts(user);
  const asked = first(tabParam);
  const tab: JobTab = isJobTab(asked) ? asked : counts.pending > 0 || counts.active === 0 ? "pending" : "active";
  const cursor = first(cursorParam) ?? null;
  let page;
  try {
    page = await listAppointments(user, "vet", cursor, new Date(), tab);
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) redirect(jobsHref(tab));
    throw error;
  }
  const empty = EMPTY[tab];
  const label = JOB_TABS.find((t) => t.value === tab)!.label;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="My jobs" />
      <div className="flex-1 px-5 pb-8">
        <nav aria-label="Job lists" className="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1 pb-1">
          {JOB_TABS.map((t) => {
            const current = t.value === tab;
            const count = t.value === "pending" || t.value === "active" ? counts[t.value] : null;
            return (
              <Link
                key={t.value}
                href={jobsHref(t.value)}
                aria-current={current ? "page" : undefined}
                className={`flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent ${
                  current
                    ? "bg-primary text-primary-foreground"
                    : "bg-white text-foreground/70 ring-1 ring-foreground/10 hover:text-foreground"
                }`}
              >
                {t.label}
                {count !== null && count > 0 && (
                  <span
                    className={`rounded-full px-1.5 text-[0.6875rem] font-semibold tabular-nums ${current ? "bg-white/20" : "bg-primary/10 text-primary"}`}
                  >
                    <span className="sr-only">(</span>
                    {count >= JOB_COUNT_CAP ? "99+" : count}
                    <span className="sr-only">)</span>
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {page.appointments.length === 0 ? (
          <EmptyList icon="briefcase" title={cursor ? "No more jobs here" : empty.title}>
            {cursor ? "You've reached the end of this list." : empty.body}
          </EmptyList>
        ) : (
          <ul aria-label={`${label} jobs`} className="space-y-3">
            {page.appointments.map((job) => (
              <JobCard key={job.id} job={job} href={`/appointments/${job.id}?from=${tab}`} />
            ))}
          </ul>
        )}

        {(cursor || page.nextCursor) && (
          <nav aria-label="Pages" className="mt-4 flex justify-between">
            {cursor ? (
              <Link
                href={jobsHref(tab)}
                className="flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-medium text-primary outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Icon name="arrow-left" className="size-4" />
                Back to start
              </Link>
            ) : (
              <span />
            )}
            {page.nextCursor && (
              <Link
                href={jobsHref(tab, page.nextCursor)}
                className="flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-medium text-primary outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent"
              >
                More
                <Icon name="chevron-right" className="size-4" />
              </Link>
            )}
          </nav>
        )}
      </div>
    </main>
  );
}
