import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminTabs, CaseLink, pageHref, pageParam, Pill, PRIORITY_TONE } from "@/components/admin/admin-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, first, formatDate, ListCard, Pager } from "@/components/wallet/wallet-parts";
import {
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  CASE_STATUS_LABELS,
  CASE_STATUSES,
  CASE_TYPE_LABELS,
} from "@/lib/admin/cases";
import { requireAdminCapabilityPage } from "@/lib/server/admin";
import { countCases, listCases, parseCaseFilters, visibleCaseTypes, type CaseFilters } from "@/lib/server/admin-cases";
import { HttpError } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

export const metadata: Metadata = { title: "Cases" };

const selectClass =
  "h-10 min-w-0 rounded-full border border-foreground/10 bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent";

// The case centre: internal investigations into flagged records. Open cases
// are listed most urgent then oldest first. A reader only sees the case
// types whose records their role can see.
export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireAdminCapabilityPage("admin.cases.read");
  await limitUser("adminReadsPerUser", access.user._id);
  const query = await searchParams;
  const raw = new URLSearchParams();
  for (const key of ["state", "status", "type", "priority", "assignee"])
    if (first(query[key])) raw.set(key, first(query[key])!);
  let filters: CaseFilters;
  try {
    filters = parseCaseFilters(raw);
  } catch (error) {
    if (error instanceof HttpError) notFound();
    throw error;
  }
  const page = pageParam(first(query.page));
  const [result, counts] = await Promise.all([listCases(access, filters, page), countCases(access)]);
  const types = visibleCaseTypes(access);
  const statuses = CASE_STATUSES.filter((s) => (filters.state === "open") === (s !== "resolved" && s !== "dismissed"));
  const params = {
    state: filters.state === "open" ? null : filters.state,
    status: filters.status,
    type: filters.type,
    priority: filters.priority,
    assignee: filters.assignee,
  };

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Cases" back={<BackLink href="/admin" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <dl className="mb-4 grid grid-cols-3 gap-2 text-center">
          {[
            ["Open", counts.open],
            ["High or urgent", counts.urgent],
            ["Unassigned", counts.unassigned],
          ].map(([label, count]) => (
            <div key={label} className="rounded-2xl bg-white px-2 py-2.5 shadow-sm ring-1 ring-foreground/5">
              <dt className="text-[0.6875rem] font-medium text-muted-foreground">{label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{Number(count).toLocaleString("en-NG")}</dd>
            </div>
          ))}
        </dl>
        <AdminTabs
          label="Case state"
          current={filters.state}
          tabs={[
            { key: "open", label: "Open", href: "/admin/cases" },
            { key: "closed", label: "Closed", href: "/admin/cases?state=closed" },
          ]}
        />
        <form method="get" className="mb-4 grid grid-cols-2 gap-2" aria-label="Filter cases">
          {filters.state === "closed" && <input type="hidden" name="state" value="closed" />}
          <select name="type" defaultValue={filters.type ?? ""} aria-label="Type" className={selectClass}>
            <option value="">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {CASE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          <select name="status" defaultValue={filters.status ?? ""} aria-label="Status" className={selectClass}>
            <option value="">Any status</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {CASE_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <select name="priority" defaultValue={filters.priority ?? ""} aria-label="Priority" className={selectClass}>
            <option value="">Any priority</option>
            {CASE_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {CASE_PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
          <select name="assignee" defaultValue={filters.assignee ?? ""} aria-label="Assignee" className={selectClass}>
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="none">Unassigned</option>
          </select>
          <button
            type="submit"
            className="col-span-2 h-10 rounded-full bg-primary text-sm font-medium text-primary-foreground outline-none hover:bg-primary-dark focus-visible:ring-2 focus-visible:ring-accent"
          >
            Apply filters
          </button>
        </form>
        {result.cases.length === 0 ? (
          <EmptyList icon="check-circle" title={page > 1 ? "No more cases" : "No cases"}>
            {filters.state === "open"
              ? "No open cases match. Open one from a flagged record in Exceptions, an order issue or an account."
              : "No closed cases match."}
          </EmptyList>
        ) : (
          <ListCard label={filters.state === "open" ? "Open cases" : "Closed cases"}>
            {result.cases.map((c) => (
              <CaseLink key={c.reference} href={`/admin/cases/${c.reference}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-xs font-medium">{c.reference}</p>
                  <span className="flex gap-1">
                    <Pill tone={PRIORITY_TONE[c.priority]}>{CASE_PRIORITY_LABELS[c.priority]}</Pill>
                    <Pill tone={c.status === "resolved" ? "good" : "neutral"}>{CASE_STATUS_LABELS[c.status]}</Pill>
                  </span>
                </div>
                <p className="mt-1 truncate text-sm font-medium">{c.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {CASE_TYPE_LABELS[c.type]} · {c.assignee ? c.assignee.name : "Unassigned"} ·{" "}
                  {formatDate(filters.state === "open" ? c.createdAt : c.updatedAt, true)}
                </p>
              </CaseLink>
            ))}
          </ListCard>
        )}
        <Pager
          newer={page > 1 ? pageHref("/admin/cases", params, page - 1) : null}
          older={result.hasMore ? pageHref("/admin/cases", params, page + 1) : null}
        />
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Cases are internal notes on an investigation. Working or closing a case never changes the order, booking,
          payout, delivery or account it&apos;s about. Every change is kept in the audit trail.
        </p>
      </div>
    </main>
  );
}
