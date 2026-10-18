import type { Metadata } from "next";
import Link from "next/link";
import {
  count,
  DataTable,
  Downloads,
  PeriodPicker,
  rangeLabel,
  Section,
  Stat,
  StatGrid,
  TrendChart,
} from "@/components/analytics/analytics-parts";
import { Facts } from "@/components/admin/admin-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { first, formatDate } from "@/components/wallet/wallet-parts";
import { PERIOD_LABELS, resolveRange } from "@/lib/analytics/range";
import { CSV_ROW_LIMIT, type AdminReport } from "@/lib/analytics/types";
import { ROLE_LABELS, type Role } from "@/lib/auth/types";
import { requireAdminPage } from "@/lib/server/admin";
import { getAdminReport } from "@/lib/server/analytics";
import { formatKobo } from "@/lib/wallet/money";

export const metadata: Metadata = { title: "Analytics" };

const BASE = "/admin/analytics";

const roleLabel = (role: string) => ROLE_LABELS[role as Role] ?? role;
const statusLabel = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, " ") : s);
const money = (x: { count: number; amountKobo: number }) => `${formatKobo(x.amountKobo)} (${count(x.count)})`;

// Marketplace reports for admins. Read-only: nothing on this page or its API
// changes any record. Only configured admins get here (everyone else gets a
// 404). Every figure is defined in docs/analytics-reporting.md.
export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();
  const params = await searchParams;
  const input = { period: first(params.period), from: first(params.from), to: first(params.to) };
  const resolved = resolveRange(input);
  const report = resolved.ok ? await getAdminReport(resolved.range) : null;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Analytics" back={<BackLink href="/admin" />} />
      <div className="flex flex-1 flex-col gap-6 px-5 pb-8">
        <PeriodPicker
          basePath={BASE}
          period={report?.range.period ?? null}
          from={report?.range.from ?? input.from ?? ""}
          to={report?.range.to ?? input.to ?? ""}
          error={resolved.ok ? null : resolved.message}
        />
        {report ? (
          <AdminReportView report={report} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Pick one of the periods above, or a custom range of up to a year that ends today or earlier.
          </p>
        )}
      </div>
    </main>
  );
}

function AdminReportView({ report }: { report: AdminReport }) {
  const { range, accounts, orders, listings, sellers, financial: f, operational: op } = report;
  const cur = orders.current;
  const prev = orders.previous;
  const p = (pick: (a: typeof cur) => number) => (prev ? pick(prev) : null);
  const newTotal = accounts.newInPeriod.reduce((t, r) => t + r.count, 0);

  return (
    <>
      <p className="-mt-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{PERIOD_LABELS[range.period]}</span>: {rangeLabel(range)} (Lagos time).
        {prev ? ` Compared with ${rangeLabel(range.previous)}.` : " No orders from before this period, so there's no comparison."}
      </p>

      <Section
        title="Accounts"
        note="Registered accounts, not active users: nothing here measures who uses the app. Unverified sign-ups are removed automatically after a while, so older periods can show fewer."
      >
        <StatGrid label="Accounts">
          <Stat
            label="New accounts"
            value={newTotal}
            format="count"
            previous={accounts.newInPreviousPeriod}
            hint="Registered in this period"
          />
          <Stat
            label="Registered accounts now"
            value={accounts.byRole.reduce((t, r) => t + r.total, 0)}
            format="count"
            hint="Current, not for the period"
          />
        </StatGrid>
        {accounts.byRole.length > 0 && (
          <DataTable
            caption="Registered accounts by role"
            columns={[
              { label: "Role" },
              { label: "Now", numeric: true },
              { label: "Verified", numeric: true },
              { label: "New in period", numeric: true },
            ]}
            rows={accounts.byRole.map((r) => ({
              key: r.role,
              cells: [
                roleLabel(r.role),
                count(r.total),
                count(r.verified),
                count(accounts.newInPeriod.find((n) => n.role === r.role)?.count ?? 0),
              ],
            }))}
          />
        )}
      </Section>

      <Section
        title="Orders"
        note="Paid means a confirmed payment in this period (each order once, however many payment attempts it took). Unpaid and expired orders are never counted as paid."
      >
        <StatGrid label="Orders this period">
          <Stat label="Orders placed" value={cur.placed} format="count" previous={p((a) => a.placed)} />
          <Stat label="Paid orders" value={cur.paid} format="count" previous={p((a) => a.paid)} />
          <Stat label="Completed (delivered)" value={cur.completed} format="count" previous={p((a) => a.completed)} />
          <Stat
            label="Cancelled"
            value={cur.cancelledUnpaid + cur.cancelledPaid}
            format="count"
            previous={prev ? prev.cancelledUnpaid + prev.cancelledPaid : null}
            hint={`${count(cur.cancelledUnpaid)} before payment (incl. expired), ${count(cur.cancelledPaid)} after`}
          />
          <Stat label="Orders with refunds" value={cur.refundedOrders} format="count" previous={p((a) => a.refundedOrders)} />
          <Stat label="Paid with a promotion" value={cur.promotionOrders} format="count" previous={p((a) => a.promotionOrders)} />
        </StatGrid>
        <TrendChart points={report.trend} value={(t) => t.salesKobo} format="kobo" title="Paid amounts" granularity={range.granularity} />
        <TrendChart points={report.trend} value={(t) => t.placed} format="count" title="Orders placed" granularity={range.granularity} />
        <TrendChart points={report.trend} value={(t) => t.newAccounts} format="count" title="New accounts" granularity={range.granularity} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Facts label="Payment status now" rows={orders.paymentStatusNow.map((s) => [statusLabel(s.status), count(s.count)])} />
          <Facts label="Fulfilment status now" rows={orders.fulfillmentStatusNow.map((s) => [statusLabel(s.status), count(s.count)])} />
        </div>
      </Section>

      <Section title="Listings, sellers and promotions" note="Current counts unless they say “in period”.">
        <StatGrid label="Listings and sellers">
          <Stat label="Live listings" value={listings.liveNow} format="count" />
          <Stat label="Hidden listings" value={listings.hiddenNow} format="count" hint="Not archived, not shown" />
          <Stat label="Archived listings" value={listings.archivedNow} format="count" />
          <Stat label="New listings in period" value={listings.newInPeriod} format="count" />
          <Stat label="Sellers with paid orders in period" value={sellers.withPaidOrders} format="count" />
          <Stat label="Sellers with live listings" value={sellers.withLiveListingsNow} format="count" />
          <Stat label="Sellers running a promotion" value={sellers.withActivePromotionNow} format="count" />
          <Stat label="Orders paid with a promotion" value={cur.promotionOrders} format="count" hint={`${formatKobo(cur.discountKobo)} discount granted`} />
        </StatGrid>
        {report.promotions.byStatusNow.length > 0 && (
          <Facts label="Promotions by status now" rows={report.promotions.byStatusNow.map((s) => [statusLabel(s.status), count(s.count)])} />
        )}
      </Section>

      <Section
        title="Money"
        note={
          <>
            Net captured = paid amounts − refunds, both for this period (a flow, not a balance; a refund can be for an earlier
            sale). Earnings and fees come only from the ledger and are recorded when payments settle, so they can differ from
            paid amounts in the same period. Payouts are counted by the date of each event and kept separate.
          </>
        }
      >
        <StatGrid label="Money this period">
          <Stat label="Paid amounts" value={f.paidKobo} format="kobo" previous={p((a) => a.salesKobo)} />
          <Stat label="Refunds" value={f.refundsKobo} format="kobo" previous={p((a) => a.refundsKobo)} />
          <Stat label="Net captured" value={f.netCapturedKobo} format="kobo" previous={prev ? prev.salesKobo - prev.refundsKobo : null} />
          <Stat label="Discounts granted" value={cur.discountKobo} format="kobo" hint="Funded by sellers; never collected" />
        </StatGrid>
        <Facts
          label="Ledger (recorded in this period)"
          rows={[
            ["Seller earnings (gross)", formatKobo(f.ledger.earningsKobo)],
            ["Platform fees recorded", formatKobo(f.ledger.feesKobo)],
            ["Fees returned with refunds", formatKobo(f.feesReturnedKobo)],
            ["Refunds taken from earnings", formatKobo(f.ledger.refundsKobo)],
            ["Net seller earnings", formatKobo(f.ledger.netKobo)],
            ["Payouts recorded as paid", formatKobo(f.ledger.payoutsPaidKobo)],
          ]}
        />
        <Facts
          label="Payouts"
          rows={[
            ["Requested in period", money(f.payouts.requested)],
            ["Paid in period", money(f.payouts.paid)],
            ["Failed in period", money(f.payouts.failed)],
            ["In progress now", money(f.payouts.inProgressNow)],
          ]}
        />
        <Facts
          label="Other refunds"
          rows={[
            ["Late payments returned in period", money(f.latePaymentsReturned)],
            ["Refunds failed in period", money(f.refundsFailed)],
            ["Refunds in progress now", money(f.refundsInProgressNow)],
          ]}
        />
      </Section>

      <Section title="Needs attention now" note="Current counts, using the same definitions as the admin queues.">
        <DataTable
          caption="Exceptions now"
          columns={[{ label: "Queue" }, { label: "Now", numeric: true }]}
          rows={[
            { key: "issues", cells: [<QueueLink key="l" href="/admin/issues" label="Open order issues" />, count(op.openIssues)] },
            { key: "orders", cells: [<QueueLink key="l" href="/admin/exceptions?kind=orders" label="Flagged orders" />, count(op.flaggedOrders)] },
            { key: "payouts", cells: [<QueueLink key="l" href="/admin/exceptions?kind=payouts" label="Flagged payouts" />, count(op.flaggedPayouts)] },
            {
              key: "deliveries",
              cells: [<QueueLink key="l" href="/admin/exceptions?kind=deliveries" label="Failed notification deliveries" />, count(op.failedDeliveries)],
            },
            { key: "sync", cells: ["Orders waiting for a ledger update", count(op.ledgerSyncPending)] },
            { key: "noledger", cells: ["Paid orders with no ledger record (no commission policy at payment)", count(op.paidNotInLedger)] },
          ]}
        />
      </Section>

      <Section
        title="Downloads"
        note={`A CSV of the daily or weekly figures for this period, amounts in kobo (₦1 = 100 kobo), up to ${count(CSV_ROW_LIMIT)} rows. No personal details.`}
      >
        <Downloads endpoint="/api/admin/analytics/export" range={range} reports={[{ report: "trend", label: "marketplace trend" }]} />
      </Section>

      <p className="text-xs text-muted-foreground">Figures as of {formatDate(report.generatedAt, true)}.</p>
    </>
  );
}

function QueueLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="font-medium text-primary hover:underline">
      {label}
    </Link>
  );
}
