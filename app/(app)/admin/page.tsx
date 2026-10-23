import type { Metadata } from "next";
import Link from "next/link";
import { AuditList, Pill } from "@/components/admin/admin-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { buttonClasses } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icons";
import { EmptyList } from "@/components/wallet/wallet-parts";
import { ADMIN_ROLE_LABELS } from "@/lib/admin/permissions";
import type { AdminSummary } from "@/lib/admin/types";
import { requireAdminPage } from "@/lib/server/admin";
import { getAdminSummary } from "@/lib/server/admin-queues";

export const metadata: Metadata = { title: "Admin" };

type Tile = { key: keyof AdminSummary; href: string; label: string; icon: IconName; note: string };

// Each tile only appears when the admin's role covers that queue (the
// summary leaves the count out otherwise).
const TILES: Tile[] = [
  { key: "openCases", href: "/admin/cases", label: "Open cases", icon: "briefcase", note: "Investigations in progress" },
  {
    key: "urgentCases",
    href: "/admin/cases",
    label: "Urgent or high cases",
    icon: "alert-circle",
    note: "Open cases at high or urgent priority",
  },
  {
    key: "unassignedCases",
    href: "/admin/cases?assignee=none",
    label: "Unassigned cases",
    icon: "users",
    note: "Open cases nobody has taken yet",
  },
  {
    key: "pendingCredentials",
    href: "/admin/credentials",
    label: "Credentials to review",
    icon: "award",
    note: "Vets and specialists waiting for a decision",
  },
  {
    key: "openIssues",
    href: "/admin/issues",
    label: "Open order issues",
    icon: "alert-circle",
    note: "Problems buyers reported; sellers' earnings on hold",
  },
  {
    key: "reviewsToModerate",
    href: "/admin/reviews",
    label: "Reviews to moderate",
    icon: "star",
    note: "Reviews waiting before they're shown",
  },
  {
    key: "flaggedOrders",
    href: "/admin/exceptions?kind=orders",
    label: "Flagged orders",
    icon: "list",
    note: "Payment or ledger mismatches to look into",
  },
  {
    key: "flaggedBookings",
    href: "/admin/exceptions?kind=bookings",
    label: "Other Services exceptions",
    icon: "wrench",
    note: "Booking payments or refunds that didn't add up",
  },
  {
    key: "flaggedPayouts",
    href: "/admin/exceptions?kind=payouts",
    label: "Flagged payouts",
    icon: "landmark",
    note: "Payouts that need a manual check",
  },
  {
    key: "failedDeliveries",
    href: "/admin/exceptions?kind=deliveries",
    label: "Failed deliveries",
    icon: "bell",
    note: "Email, SMS or push messages that didn't go out",
  },
  {
    key: "suspendedAccounts",
    href: "/admin/users",
    label: "Suspended accounts",
    icon: "lock",
    note: "Accounts that can't sign in",
  },
  {
    key: "recentAccountActions",
    href: "/admin/users",
    label: "Account actions (7 days)",
    icon: "user",
    note: "Suspensions and reactivations this week",
  },
];

// The admin dashboard: live counts from the database for the queues this
// admin's role covers, and the latest admin actions for those who may read
// the audit trail. A count that couldn't be read shows as an error, never
// as 0. Access is decided on the server for this page and every page under it.
export default async function AdminPage() {
  const access = await requireAdminPage();
  const summary = await getAdminSummary(access);
  const tiles = TILES.filter((t) => summary[t.key] !== undefined);
  const failed = tiles.some((t) => summary[t.key] === null);

  const links: { href: string; label: string; icon: IconName; show: boolean }[] = [
    { href: "/admin/cases", label: "Case centre", icon: "briefcase", show: access.can("admin.cases.read") },
    { href: "/admin/users", label: "Find an account", icon: "search", show: access.can("admin.users.read") },
    { href: "/admin/team", label: "Admin team and roles", icon: "shield-check", show: access.can("admin.team.manage") },
    { href: "/admin/analytics", label: "Marketplace analytics", icon: "list", show: access.can("admin.analytics.read") },
    { href: "/admin/training", label: "Training courses", icon: "graduation-cap", show: access.can("admin.training.manage") },
  ];

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Admin" back={<BackLink href="/profile" />} />
      <div className="flex flex-1 flex-col gap-5 px-5 pb-8">
        <p className="-mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          Signed in as <Pill tone="good">{ADMIN_ROLE_LABELS[access.role]}</Pill>
          {access.root && <span>(root, from server configuration)</span>}
        </p>
        {failed && (
          <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-3 text-sm text-red-800">
            Some counts couldn&apos;t be loaded. They&apos;re marked below; reload to try again.
          </p>
        )}
        {tiles.length > 0 && (
          <section aria-label="Queues" className="grid grid-cols-2 gap-3">
            {tiles.map((t) => {
              const count = summary[t.key] as number | null;
              return (
                <Link
                  key={t.key}
                  href={t.href}
                  className="flex flex-col rounded-2xl bg-white p-3.5 shadow-sm ring-1 ring-foreground/5 outline-none hover:bg-primary/[0.03] focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Icon name={t.icon} className="size-3.5" />
                    {t.label}
                  </span>
                  {count === null ? (
                    <span className="mt-1.5 text-sm font-semibold text-red-700">Couldn&apos;t load</span>
                  ) : (
                    <span
                      className={`mt-1.5 text-2xl font-semibold tabular-nums ${count ? "text-foreground" : "text-foreground/40"}`}
                    >
                      {count.toLocaleString("en-NG")}
                    </span>
                  )}
                  <span className="mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground">{t.note}</span>
                </Link>
              );
            })}
          </section>
        )}

        <div className="flex flex-col gap-2">
          {links
            .filter((l) => l.show)
            .map((l) => (
              <Link key={l.href} href={l.href} className={buttonClasses("outline", "gap-2")}>
                <Icon name={l.icon} className="size-4" />
                {l.label}
              </Link>
            ))}
        </div>

        {summary.recentActions !== undefined && (
          <section aria-labelledby="recent-heading">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="recent-heading" className="text-sm font-semibold">
                Recent admin actions
              </h2>
              <Link href="/admin/audit" className="text-sm font-medium text-primary hover:underline">
                Audit trail
              </Link>
            </div>
            {summary.recentActions === null ? (
              <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-3 text-sm text-red-800">
                Recent actions couldn&apos;t be loaded. Reload to try again.
              </p>
            ) : summary.recentActions.length ? (
              <AuditList entries={summary.recentActions} showTarget />
            ) : (
              <EmptyList icon="shield-check" title="No admin actions yet">
                Admin decisions and changes are recorded here as they happen.
              </EmptyList>
            )}
          </section>
        )}

        <p className="text-xs leading-relaxed text-muted-foreground">
          Payouts, refunds, payments and the ledger can&apos;t be changed from here. Flagged items are shown for
          investigation only.
        </p>
      </div>
    </main>
  );
}
