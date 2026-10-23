import type { Metadata } from "next";
import Link from "next/link";
import { AdminTabs, humanize, pageHref, pageParam, Pill } from "@/components/admin/admin-parts";
import { OpenCaseButton } from "@/components/admin/open-case-button";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, FAILURE_REASONS, first, formatDate, ListCard, Pager } from "@/components/wallet/wallet-parts";
import { maskAccountNumber } from "@/lib/bank-details/validation";
import { CASE_STATUS_LABELS, isCaseStatus, type CaseType } from "@/lib/admin/cases";
import {
  EXCEPTION_CATEGORY_LABELS,
  MONEY_OUTCOME_LABELS,
  type ExceptionCaseLink,
  type ExceptionKind,
  type MoneyOutcome,
} from "@/lib/admin/types";
import { requireAdminCapabilityPage } from "@/lib/server/admin";
import { listExceptions } from "@/lib/server/admin-queues";
import { formatKobo } from "@/lib/wallet/money";
import type { PayoutFailureReason } from "@/lib/wallet/types";

export const metadata: Metadata = { title: "Exceptions" };

const TABS: { key: ExceptionKind; label: string; empty: string; caseType: CaseType }[] = [
  {
    key: "orders",
    label: "Orders",
    empty: "No orders are flagged for a payment or ledger mismatch.",
    caseType: "order_payment",
  },
  {
    key: "bookings",
    label: "Services",
    empty: "No Other Services bookings are flagged for a payment or refund mismatch.",
    caseType: "service_booking",
  },
  { key: "payouts", label: "Payouts", empty: "No payouts are flagged for a manual check.", caseType: "payout" },
  {
    key: "deliveries",
    label: "Deliveries",
    empty: "No email, SMS or push deliveries have failed.",
    caseType: "notification_delivery",
  },
];

const OUTCOME_TONE: Record<MoneyOutcome, "good" | "bad" | "waiting" | "neutral"> = {
  confirmed: "good",
  failed: "bad",
  ambiguous: "waiting",
  in_progress: "neutral",
};

function Outcome({ outcome }: { outcome: MoneyOutcome }) {
  return <Pill tone={OUTCOME_TONE[outcome]}>{MONEY_OUTCOME_LABELS[outcome]}</Pill>;
}

// Operational exceptions, for investigation only: nothing here retries,
// refunds, pays out or touches the ledger. The only action is opening an
// internal case, which changes nothing about the record. Money tabs need
// admin.exceptions.read and the deliveries tab admin.deliveries.read; an
// admin only sees the tabs their role covers.
export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireAdminCapabilityPage(["admin.exceptions.read", "admin.deliveries.read"]);
  const tabs = TABS.filter((t) =>
    access.can(t.key === "deliveries" ? "admin.deliveries.read" : "admin.exceptions.read"),
  );
  const query = await searchParams;
  const requested = first(query.kind);
  const tab = tabs.find((t) => t.key === requested) ?? tabs[0];
  const kind = tab.key;
  const page = pageParam(first(query.page));
  const result = await listExceptions(kind, page);
  const filters = { kind };
  const canOpen =
    access.can("admin.cases.read") && (access.can("admin.cases.manage") || access.can("admin.cases.assign"));

  const caseCell = (link: ExceptionCaseLink, sourceId: string) =>
    link ? (
      <Link href={`/admin/cases/${link.reference}`} className="text-xs font-medium text-primary hover:underline">
        Case {link.reference} · {isCaseStatus(link.status) ? CASE_STATUS_LABELS[link.status] : humanize(link.status)}
      </Link>
    ) : canOpen ? (
      <OpenCaseButton type={tab.caseType} sourceId={sourceId} />
    ) : null;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Exceptions" back={<BackLink href="/admin" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        {tabs.length > 1 && (
          <AdminTabs
            label="Exception type"
            current={kind}
            tabs={tabs.map((t) => ({ key: t.key, label: t.label, href: pageHref("/admin/exceptions", { kind: t.key }, 1) }))}
          />
        )}
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Read only. Nothing here retries, refunds, pays out or changes the ledger; investigate with Paystack and the
          records first. &ldquo;Paid (recorded)&rdquo; is what our records hold, not a fresh check with the provider.
        </p>
        {result.items.length === 0 ? (
          <EmptyList icon="check-circle" title={page > 1 ? "No more items" : "All clear"}>
            {tab.empty}
          </EmptyList>
        ) : (
          <ListCard label={`Flagged ${tab.label.toLowerCase()}`}>
            {result.kind === "orders" &&
              result.items.map((o) => (
                <li key={o.orderNumber} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-sm font-medium">{o.orderNumber}</p>
                    <Outcome outcome={o.outcome} />
                  </div>
                  <p className="mt-1 text-xs font-medium text-foreground/70">{EXCEPTION_CATEGORY_LABELS[o.category]}</p>
                  <p className="mt-0.5 text-sm break-words text-foreground/80">{o.issue}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Expected {formatKobo(o.totalKobo)} · Paid (recorded){" "}
                    {o.paidKobo === null ? "nothing recorded" : formatKobo(o.paidKobo)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {humanize(o.paymentStatus)} · {humanize(o.fulfillmentStatus)} · {formatDate(o.updatedAt, true)}
                  </p>
                  <div className="mt-1.5">{caseCell(o.openCase, o.orderNumber)}</div>
                </li>
              ))}
            {result.kind === "bookings" &&
              result.items.map((b) => (
                <li key={b.reference} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-sm font-medium">{b.reference}</p>
                    <Outcome outcome={b.outcome} />
                  </div>
                  <p className="mt-1 text-xs font-medium text-foreground/70">{EXCEPTION_CATEGORY_LABELS[b.category]}</p>
                  <p className="mt-0.5 text-sm break-words text-foreground/80">{b.issue}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Expected {formatKobo(b.expectedKobo)} · Paid (recorded){" "}
                    {b.paidKobo === null ? "nothing recorded" : formatKobo(b.paidKobo)}
                    {b.refundedKobo > 0 && ` · Refunded ${formatKobo(b.refundedKobo)}`}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Booking {humanize(b.status).toLowerCase()} · Payment {humanize(b.paymentStatus).toLowerCase()}
                    {b.refundStatus && ` · Refund ${humanize(b.refundStatus).toLowerCase()}`}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Booked {formatDate(b.createdAt, true)}
                    {b.paidAt && ` · Paid ${formatDate(b.paidAt, true)}`} · Updated {formatDate(b.updatedAt, true)}
                  </p>
                  <div className="mt-1.5">{caseCell(b.openCase, b.reference)}</div>
                </li>
              ))}
            {result.kind === "payouts" &&
              result.items.map((p) => (
                <li key={p.reference} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-xs font-medium break-all">{p.reference}</p>
                    <Outcome outcome={p.outcome} />
                  </div>
                  <p className="mt-1 text-xs font-medium text-foreground/70">{EXCEPTION_CATEGORY_LABELS[p.category]}</p>
                  <p className="mt-0.5 text-sm break-words text-foreground/80">{p.issue}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Amount {formatKobo(p.amountKobo)} · {p.bankName}{" "}
                    <span aria-hidden="true">{maskAccountNumber(p.accountNumberLast4)}</span>
                    <span className="sr-only">account ending in {p.accountNumberLast4}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {humanize(p.status)} · {formatDate(p.updatedAt, true)}
                  </p>
                  {p.failureReason && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {FAILURE_REASONS[p.failureReason as PayoutFailureReason] ?? humanize(p.failureReason)}
                    </p>
                  )}
                  <div className="mt-1.5">{caseCell(p.openCase, p.reference)}</div>
                </li>
              ))}
            {result.kind === "deliveries" &&
              result.items.map((d) => (
                <li key={d.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {humanize(d.channel)} · {d.notificationType ? humanize(d.notificationType) : "Unknown message"}
                    </p>
                    <Pill tone={d.state === "exhausted" ? "bad" : "waiting"}>{humanize(d.state)}</Pill>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {d.attempts} {d.attempts === 1 ? "attempt" : "attempts"}
                    {d.lastFailure && ` · ${humanize(d.lastFailure)}`} · {formatDate(d.updatedAt, true)}
                  </p>
                  <div className="mt-1.5">{caseCell(d.openCase, d.id)}</div>
                </li>
              ))}
          </ListCard>
        )}
        <Pager
          newer={page > 1 ? pageHref("/admin/exceptions", filters, page - 1) : null}
          older={result.hasMore ? pageHref("/admin/exceptions", filters, page + 1) : null}
        />
      </div>
    </main>
  );
}
