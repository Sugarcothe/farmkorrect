import type { Metadata } from "next";
import { AdminTabs, CaseLink, pageHref, pageParam, Pill } from "@/components/admin/admin-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, first, formatDate, ListCard, Pager } from "@/components/wallet/wallet-parts";
import { requireAdminCapabilityPage } from "@/lib/server/admin";
import { listIssues } from "@/lib/server/admin-queues";
import { formatKobo } from "@/lib/wallet/money";

export const metadata: Metadata = { title: "Order issues" };

// Problems buyers reported on their orders: open ones oldest first, or
// closed ones newest first.
export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminCapabilityPage("admin.order_issues.read");
  const query = await searchParams;
  const state = first(query.state) === "closed" ? "closed" : "open";
  const page = pageParam(first(query.page));
  const { cases, hasMore } = await listIssues(state, page);
  const filters = { state: state === "closed" ? "closed" : null };

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Order issues" back={<BackLink href="/admin" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <AdminTabs
          label="Issue status"
          current={state}
          tabs={[
            { key: "open", label: "Open", href: "/admin/issues" },
            { key: "closed", label: "Closed", href: "/admin/issues?state=closed" },
          ]}
        />
        {cases.length ? (
          <ListCard label={state === "open" ? "Open issues" : "Closed issues"}>
            {cases.map((c) => (
              <CaseLink key={c.orderNumber} href={`/admin/issues/${c.orderNumber}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-sm font-medium">{c.orderNumber}</p>
                  <span className="text-sm font-semibold tabular-nums">{formatKobo(c.totalKobo)}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-sm text-foreground/75">{c.note}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>Reported {formatDate(c.reportedAt, true)}</span>
                  {c.earningHeld && <Pill tone="waiting">Earning held</Pill>}
                  {c.refundPendingKobo > 0 && <Pill tone="waiting">Refund in progress</Pill>}
                  {c.refundedKobo > 0 && <Pill>Refunded {formatKobo(c.refundedKobo)}</Pill>}
                </div>
              </CaseLink>
            ))}
          </ListCard>
        ) : (
          <EmptyList icon="check-circle" title={state === "open" ? "No open issues" : "No closed issues"}>
            {state === "open"
              ? "When a buyer reports a problem with an order, it appears here until it's resolved and closed."
              : "Issues closed by an admin or the support job are listed here."}
          </EmptyList>
        )}
        <Pager
          newer={page > 1 ? pageHref("/admin/issues", filters, page - 1) : null}
          older={hasMore ? pageHref("/admin/issues", filters, page + 1) : null}
        />
      </div>
    </main>
  );
}
