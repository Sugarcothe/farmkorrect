import type { Metadata } from "next";
import { AdminTabs, humanize, pageHref, pageParam, Pill } from "@/components/admin/admin-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, FAILURE_REASONS, first, formatDate, ListCard, Pager } from "@/components/wallet/wallet-parts";
import { maskAccountNumber } from "@/lib/bank-details/validation";
import { isExceptionKind, type ExceptionKind } from "@/lib/admin/types";
import { requireAdminPage } from "@/lib/server/admin";
import { listExceptions } from "@/lib/server/admin-queues";
import { formatKobo } from "@/lib/wallet/money";
import type { PayoutFailureReason } from "@/lib/wallet/types";

export const metadata: Metadata = { title: "Exceptions" };

const TABS: { key: ExceptionKind; label: string; empty: string }[] = [
  { key: "orders", label: "Orders", empty: "No orders are flagged for a payment or ledger mismatch." },
  { key: "payouts", label: "Payouts", empty: "No payouts are flagged for a manual check." },
  { key: "deliveries", label: "Deliveries", empty: "No email, SMS or push deliveries have failed." },
];

// Operational exceptions, for investigation only: there are deliberately
// no actions here. Payouts show the bank name and last four digits only.
export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();
  const query = await searchParams;
  const requested = first(query.kind);
  const kind: ExceptionKind = isExceptionKind(requested) ? requested : "orders";
  const page = pageParam(first(query.page));
  const result = await listExceptions(kind, page);
  const filters = { kind };

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Exceptions" back={<BackLink href="/admin" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <AdminTabs
          label="Exception type"
          current={kind}
          tabs={TABS.map((t) => ({ key: t.key, label: t.label, href: pageHref("/admin/exceptions", { kind: t.key }, 1) }))}
        />
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Read only. Nothing here retries, refunds, pays out or changes the ledger; investigate with Paystack and the
          records first.
        </p>
        {result.items.length === 0 ? (
          <EmptyList icon="check-circle" title={page > 1 ? "No more items" : "All clear"}>
            {TABS.find((t) => t.key === kind)!.empty}
          </EmptyList>
        ) : (
          <ListCard label={`Flagged ${kind}`}>
            {result.kind === "orders" &&
              result.items.map((o) => (
                <li key={o.orderNumber} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-sm font-medium">{o.orderNumber}</p>
                    <span className="text-sm font-semibold tabular-nums">{formatKobo(o.totalKobo)}</span>
                  </div>
                  <p className="mt-1 text-sm break-words text-foreground/80">{o.issue}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {humanize(o.paymentStatus)} · {humanize(o.fulfillmentStatus)} · {formatDate(o.updatedAt, true)}
                  </p>
                </li>
              ))}
            {result.kind === "payouts" &&
              result.items.map((p) => (
                <li key={p.reference} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-xs font-medium break-all">{p.reference}</p>
                    <span className="text-sm font-semibold tabular-nums">{formatKobo(p.amountKobo)}</span>
                  </div>
                  <p className="mt-1 text-sm break-words text-foreground/80">{p.issue}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {p.bankName} <span aria-hidden="true">{maskAccountNumber(p.accountNumberLast4)}</span>
                    <span className="sr-only">account ending in {p.accountNumberLast4}</span> · {humanize(p.status)} ·{" "}
                    {formatDate(p.updatedAt, true)}
                  </p>
                  {p.failureReason && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {FAILURE_REASONS[p.failureReason as PayoutFailureReason] ?? humanize(p.failureReason)}
                    </p>
                  )}
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
