import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
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
import { StatePill } from "@/components/promotions/promotion-parts";
import { EmptyList, first, formatDate } from "@/components/wallet/wallet-parts";
import { PERIOD_LABELS, resolveRange } from "@/lib/analytics/range";
import { CSV_ROW_LIMIT, MIN_ORDERS_FOR_RANKING, type ProductPerformance } from "@/lib/analytics/types";
import { getSellerReport } from "@/lib/server/analytics";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { SELLER_ROLE } from "@/lib/server/products";
import { formatKobo } from "@/lib/wallet/money";

export const metadata: Metadata = { title: "Sales Insights" };

const BASE = "/market/insights";

// The signed-in farmer's sales, products, earnings and promotions for a
// period, computed on the server from their own records (the seller is the
// session's user; nothing in the URL can change whose data this is). Every
// figure is defined in docs/analytics-reporting.md.
export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  if (user.role !== SELLER_ROLE) redirect("/market");
  const params = await searchParams;
  const input = { period: first(params.period), from: first(params.from), to: first(params.to) };
  const resolved = resolveRange(input);
  const report = resolved.ok ? await getSellerReport(user._id, resolved.range) : null;
  const range = report?.range ?? null;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Sales Insights" back={<BackLink href="/market" />} />
      <div className="flex flex-1 flex-col gap-6 px-5 pb-8">
        <PeriodPicker
          basePath={BASE}
          period={range?.period ?? null}
          from={range?.from ?? input.from ?? ""}
          to={range?.to ?? input.to ?? ""}
          error={resolved.ok ? null : resolved.message}
        />
        {report && range && <SellerReportView report={report} />}
        {!report && (
          <p className="text-sm text-muted-foreground">
            Pick one of the periods above, or a custom range of up to a year that ends today or earlier.
          </p>
        )}
      </div>
    </main>
  );
}

function SellerReportView({ report }: { report: NonNullable<Awaited<ReturnType<typeof getSellerReport>>> }) {
  const { range, overview, products, earnings } = report;
  const cur = overview.current;
  const prev = overview.previous;
  const p = (pick: (a: typeof cur) => number) => (prev ? pick(prev) : null);

  return (
    <>
      <p className="-mt-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{PERIOD_LABELS[range.period]}</span>: {rangeLabel(range)} (Lagos time).
        {prev
          ? ` Compared with ${rangeLabel(range.previous)}.`
          : " You have no orders from before this period, so there's nothing to compare with yet."}
      </p>

      <Section
        title="Sales overview"
        note={
          <>
            Sales collected is what buyers actually paid (after any discount) for orders paid in this period; unpaid, cancelled
            before payment and expired orders are never counted. Refunds are counted when Paystack confirmed them, even for a sale
            from an earlier period.
          </>
        }
      >
        <StatGrid label="Sales overview">
          <Stat label="Sales collected" value={cur.salesKobo} format="kobo" previous={p((a) => a.salesKobo)} />
          <Stat label="Paid orders" value={cur.paid} format="count" previous={p((a) => a.paid)} />
          <Stat label="Refunds" value={cur.refundsKobo} format="kobo" previous={p((a) => a.refundsKobo)} hint={`${count(cur.refundedOrders)} order${cur.refundedOrders === 1 ? "" : "s"}`} />
          <Stat
            label="Sales after refunds"
            value={cur.salesKobo - cur.refundsKobo}
            format="kobo"
            previous={prev ? prev.salesKobo - prev.refundsKobo : null}
          />
          <Stat label="Discounts you gave" value={cur.discountKobo} format="kobo" previous={p((a) => a.discountKobo)} hint="Never collected, so not part of sales" />
          <Stat label="Orders placed" value={cur.placed} format="count" previous={p((a) => a.placed)} hint="Paid or not" />
          <Stat label="Completed (delivered)" value={cur.completed} format="count" previous={p((a) => a.completed)} />
          <Stat
            label="Cancelled"
            value={cur.cancelledUnpaid + cur.cancelledPaid}
            format="count"
            previous={prev ? prev.cancelledUnpaid + prev.cancelledPaid : null}
            hint={`${count(cur.cancelledUnpaid)} before payment (incl. expired), ${count(cur.cancelledPaid)} after`}
          />
          <Stat label="Awaiting payment now" value={overview.awaitingPaymentNow} format="count" hint="Current, not for the period" />
        </StatGrid>
        <TrendChart
          points={report.trend}
          value={(t) => t.salesKobo}
          format="kobo"
          title="Sales collected"
          granularity={range.granularity}
        />
        <TrendChart points={report.trend} value={(t) => t.paidOrders} format="count" title="Paid orders" granularity={range.granularity} />
      </Section>

      <Section
        title="Products"
        note="Product sales are line prices less their share of any discount, from paid orders, before refunds (refunds are per order, not per product)."
      >
        {products.insufficientHistory && (
          <p role="status" className="rounded-2xl bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-900">
            Not enough history yet: fewer than {MIN_ORDERS_FOR_RANKING} paid orders in this period, so rankings say little.
          </p>
        )}
        {products.bySales.length ? (
          <>
            <ProductTable caption="Best sellers by sales" rows={products.bySales} />
            <ProductTable caption="Best sellers by units" rows={products.byUnits} />
          </>
        ) : (
          <EmptyList icon="store" title="No product sales in this period">
            Sales appear here once buyers pay for orders.
          </EmptyList>
        )}
        {products.unsoldCount > 0 && (
          <div className="rounded-3xl bg-white px-4 py-3.5 text-sm shadow-sm ring-1 ring-foreground/5">
            <p className="font-medium">
              {count(products.unsoldCount)} listing{products.unsoldCount === 1 ? "" : "s"} with no sales in this period
            </p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted-foreground">
              {products.unsold.map((u) => (
                <li key={u.productId} className="break-words">
                  {u.name}
                  {!u.live && " (hidden)"}
                </li>
              ))}
            </ul>
            {products.unsoldCount > products.unsold.length && (
              <p className="mt-1.5 text-xs text-muted-foreground">Showing the {products.unsold.length} newest.</p>
            )}
          </div>
        )}
      </Section>

      <Section
        title="Earnings"
        note={
          <>
            Earnings, fees and refunds come from your wallet ledger: they&apos;re recorded when an order&apos;s payment is
            settled, so they can differ from sales collected in the same period. Discounts are already reflected in what buyers
            paid and aren&apos;t subtracted again. Balances are exactly what your{" "}
            <Link href="/wallet" className="font-medium text-primary underline">
              Wallet
            </Link>{" "}
            shows.
          </>
        }
      >
        <StatGrid label="Earnings this period">
          <Stat label="Earnings recorded" value={earnings.ledger.earningsKobo} format="kobo" hint="Gross, from paid orders" />
          <Stat label="Platform fees" value={earnings.ledger.feesKobo} format="kobo" hint="As recorded in your ledger" />
          <Stat label="Refunds from earnings" value={earnings.ledger.refundsKobo} format="kobo" hint="Your share of refunds" />
          <Stat label="Net earnings" value={earnings.ledger.netKobo} format="kobo" />
        </StatGrid>
        {earnings.paidNotInLedgerNow > 0 && (
          <p role="status" className="rounded-2xl bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-900">
            {count(earnings.paidNotInLedgerNow)} paid order{earnings.paidNotInLedgerNow === 1 ? " isn't" : "s aren't"} in your
            ledger yet, so {earnings.paidNotInLedgerNow === 1 ? "its earning isn't" : "their earnings aren't"} counted above. No
            amount is estimated for them.
          </p>
        )}
        <Facts
          label="Balances now"
          rows={[
            ["Available", formatKobo(earnings.balances.availableKobo)],
            ["Pending", formatKobo(earnings.balances.pendingKobo)],
            ["On hold (under review)", formatKobo(earnings.balances.underReviewKobo)],
            ["Held for payouts", formatKobo(earnings.balances.heldKobo)],
            ["Paid out to date", formatKobo(earnings.balances.paidOutKobo)],
            ...(earnings.balances.owedKobo > 0 ? ([["Owed from future earnings", formatKobo(earnings.balances.owedKobo)]] as [string, string][]) : []),
          ]}
        />
        <DataTable
          caption="Payouts requested in this period, by current status"
          columns={[{ label: "Payouts requested" }, { label: "Count", numeric: true }, { label: "Amount", numeric: true }]}
          rows={(["requested", "processing", "paid", "failed"] as const).map((s) => ({
            key: s,
            cells: [s[0].toUpperCase() + s.slice(1), count(earnings.payouts.requested[s].count), formatKobo(earnings.payouts.requested[s].amountKobo)],
          }))}
        />
        <p className="text-xs text-muted-foreground">
          Paid to your bank in this period: {formatKobo(earnings.payouts.paidInPeriod.amountKobo)} (
          {count(earnings.payouts.paidInPeriod.count)}). Failed in this period: {formatKobo(earnings.payouts.failedInPeriod.amountKobo)} (
          {count(earnings.payouts.failedInPeriod.count)}); a failed payout&apos;s amount goes back to your balance.
        </p>
      </Section>

      <Section
        title="Promotions"
        note="Paid orders, discount and sales use each order as it was priced. Uses held by unpaid orders aren't completed uses. No profit is worked out here."
      >
        {report.promotions.length ? (
          <DataTable
            caption="Promotion results for this period"
            columns={[
              { label: "Promotion" },
              { label: "Paid orders", numeric: true },
              { label: "Uses held now", numeric: true },
              { label: "Discount", numeric: true },
              { label: "Sales", numeric: true },
            ]}
            rows={report.promotions.map((pr) => ({
              key: pr.promotionId,
              cells: [
                <span key="n" className="flex flex-col items-start gap-1">
                  {pr.state ? (
                    <Link href={`/market/promotions/${pr.promotionId}`} className="font-medium text-primary hover:underline">
                      {pr.name}
                    </Link>
                  ) : (
                    pr.name
                  )}
                  {pr.state && <StatePill state={pr.state} />}
                </span>,
                count(pr.paidOrders),
                count(pr.reservedUsesNow),
                formatKobo(pr.discountKobo),
                formatKobo(pr.salesKobo),
              ],
            }))}
          />
        ) : (
          <EmptyList icon="star" title="No promotion activity">
            Promotions you run, and orders that used them, appear here.
          </EmptyList>
        )}
      </Section>

      <Section
        title="Downloads"
        note={`CSV files for this period, amounts in kobo (₦1 = 100 kobo), up to ${count(CSV_ROW_LIMIT)} rows each.`}
      >
        <Downloads
          endpoint="/api/analytics/seller/export"
          range={range}
          reports={[
            { report: "trend", label: "sales by day" },
            { report: "products", label: "product sales" },
            { report: "promotions", label: "promotion results" },
          ]}
        />
      </Section>

      <p className="text-xs text-muted-foreground">Figures as of {formatDate(report.generatedAt, true)}.</p>
    </>
  );
}

function ProductTable({ caption, rows }: { caption: string; rows: ProductPerformance[] }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-medium">{caption}</h3>
      <DataTable
        caption={caption}
        columns={[{ label: "Product" }, { label: "Units", numeric: true }, { label: "Orders", numeric: true }, { label: "Sales", numeric: true }]}
        rows={rows.map((r) => ({ key: r.productId, cells: [r.name, count(r.units), count(r.orders), formatKobo(r.salesKobo)] }))}
      />
    </div>
  );
}
