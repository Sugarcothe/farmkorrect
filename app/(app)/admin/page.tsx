import type { Metadata } from "next";
import Link from "next/link";
import { AuditList } from "@/components/admin/admin-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { buttonClasses } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icons";
import { EmptyList } from "@/components/wallet/wallet-parts";
import { requireAdminPage } from "@/lib/server/admin";
import { getAdminSummary } from "@/lib/server/admin-queues";

export const metadata: Metadata = { title: "Admin" };

// The admin dashboard: live counts from the database and the latest admin
// actions. Only configured admins get here (anyone else sees a 404 page);
// the check runs on the server for this page and every page under it.
export default async function AdminPage() {
  await requireAdminPage();
  const summary = await getAdminSummary();

  const queues: { href: string; label: string; count: number; icon: IconName; note: string }[] = [
    {
      href: "/admin/credentials",
      label: "Credentials to review",
      count: summary.pendingCredentials,
      icon: "award",
      note: "Vets and specialists waiting for a decision",
    },
    {
      href: "/admin/issues",
      label: "Open order issues",
      count: summary.openIssues,
      icon: "alert-circle",
      note: "Problems buyers reported; sellers' earnings on hold",
    },
    {
      href: "/admin/reviews",
      label: "Reviews to moderate",
      count: summary.reviewsToModerate,
      icon: "star",
      note: "Reviews waiting before they're shown",
    },
    {
      href: "/admin/exceptions?kind=orders",
      label: "Flagged orders",
      count: summary.flaggedOrders,
      icon: "list",
      note: "Payment or ledger mismatches to look into",
    },
    {
      href: "/admin/exceptions?kind=payouts",
      label: "Flagged payouts",
      count: summary.flaggedPayouts,
      icon: "landmark",
      note: "Payouts that need a manual check",
    },
    {
      href: "/admin/exceptions?kind=deliveries",
      label: "Failed deliveries",
      count: summary.failedDeliveries,
      icon: "bell",
      note: "Email, SMS or push messages that didn't go out",
    },
  ];

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Admin" back={<BackLink href="/profile" />} />
      <div className="flex flex-1 flex-col gap-5 px-5 pb-8">
        <section aria-label="Queues" className="grid grid-cols-2 gap-3">
          {queues.map((q) => (
            <Link
              key={q.href}
              href={q.href}
              className="flex flex-col rounded-2xl bg-white p-3.5 shadow-sm ring-1 ring-foreground/5 outline-none hover:bg-primary/[0.03] focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Icon name={q.icon} className="size-3.5" />
                {q.label}
              </span>
              <span className={`mt-1.5 text-2xl font-semibold tabular-nums ${q.count ? "text-foreground" : "text-foreground/40"}`}>
                {q.count.toLocaleString("en-NG")}
              </span>
              <span className="mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground">{q.note}</span>
            </Link>
          ))}
        </section>

        <Link href="/admin/analytics" className={buttonClasses("outline", "gap-2")}>
          <Icon name="list" className="size-4" />
          Marketplace analytics
        </Link>
        <Link href="/admin/training" className={buttonClasses("outline", "-mt-2 gap-2")}>
          <Icon name="graduation-cap" className="size-4" />
          Training courses
        </Link>

        <section aria-labelledby="recent-heading">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="recent-heading" className="text-sm font-semibold">
              Recent admin actions
            </h2>
            <Link href="/admin/audit" className="text-sm font-medium text-primary hover:underline">
              Audit trail
            </Link>
          </div>
          {summary.recentActions.length ? (
            <AuditList entries={summary.recentActions} showTarget />
          ) : (
            <EmptyList icon="shield-check" title="No admin actions yet">
              Decisions on credentials, order issues and reviews are recorded here as they happen.
            </EmptyList>
          )}
        </section>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Payouts, refunds, payments and the ledger can&apos;t be changed from here. Flagged items are shown for
          investigation only.
        </p>
      </div>
    </main>
  );
}
