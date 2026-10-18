import type { ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icons";
import type { DashboardAction, DashboardStats, DashboardStatsResult } from "@/lib/home/dashboard";

/**
 * The signed-in home: a greeting, the provider's own job counts when they
 * have any, and Quick Actions into the app's features. Purely presentational;
 * the page reads everything for the session's user.
 */
export function Dashboard({
  greeting,
  name,
  subtitle,
  stats,
  actions,
  bell,
}: {
  greeting: string;
  name: string;
  subtitle: string;
  stats: DashboardStatsResult;
  actions: readonly DashboardAction[];
  bell: ReactNode;
}) {
  return (
    <main className="flex flex-1 flex-col">
      <header className="flex items-start justify-between gap-3 rounded-b-3xl bg-primary px-5 pt-6 pb-6 text-primary-foreground">
        <div className="min-w-0">
          <p className="text-sm text-primary-foreground/80">{greeting},</p>
          <h1 className="mt-0.5 truncate text-xl font-semibold">{name}</h1>
          <p className="mt-1 truncate text-xs text-primary-foreground/75">{subtitle}</p>
        </div>
        {bell}
      </header>

      <div className="flex flex-1 flex-col gap-6 px-5 pt-5 pb-8">
        {stats !== null && <StatsSection stats={stats} />}

        <section aria-labelledby="quick-actions-heading">
          <h2 id="quick-actions-heading" className="mb-3 text-base font-semibold">
            Quick Actions
          </h2>
          <ul className="grid grid-cols-2 gap-3">
            {actions.map((a) => (
              <li key={a.key} className="flex">
                <Link
                  href={a.href}
                  className="flex min-h-[7.5rem] w-full flex-col rounded-2xl bg-white p-4 shadow-sm ring-1 ring-foreground/5 outline-none hover:ring-primary/30 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
                    <Icon name={a.icon} className="size-5" />
                  </span>
                  <span className="mt-3 text-sm leading-snug font-semibold">{a.title}</span>
                  <span className="mt-0.5 text-xs leading-snug text-muted-foreground">{a.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}

function StatsSection({ stats }: { stats: DashboardStats | "unavailable" }) {
  if (stats === "unavailable") {
    return (
      <section
        aria-label="Your jobs"
        role="status"
        className="rounded-2xl bg-white px-4 py-4 text-sm ring-1 ring-foreground/5"
      >
        <p className="font-medium">Your job figures couldn&rsquo;t be loaded</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Reload the page to try again. Everything below still works.
        </p>
      </section>
    );
  }
  const jobsHref = stats.source === "appointments" ? "/jobs" : "/services/jobs";
  const cards = [
    { label: "Today's jobs", value: stats.today },
    { label: "This week", value: stats.thisWeek },
    { label: "Completed", value: stats.completed },
    { label: "Awaiting reply", value: stats.awaitingReply },
  ];
  return (
    <section aria-labelledby="stats-heading">
      <h2 id="stats-heading" className="sr-only">
        Your jobs
      </h2>
      <dl className="grid grid-cols-2 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-2xl bg-white px-4 py-3.5 shadow-sm ring-1 ring-foreground/5">
            <dt className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">{c.label}</dt>
            <dd className="mt-1 text-2xl font-semibold text-primary tabular-nums">{c.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        Jobs you&rsquo;ve accepted, by booked day (Lagos time); the week runs Monday to Sunday and Completed is all
        time.{" "}
        <Link href={jobsHref} className="font-medium text-primary underline-offset-2 hover:underline">
          See all jobs
        </Link>
      </p>
    </section>
  );
}
