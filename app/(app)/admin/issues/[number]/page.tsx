import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuditList, Facts, humanize, Pill } from "@/components/admin/admin-parts";
import { CloseIssueForm } from "@/components/admin/close-issue-form";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { formatDate } from "@/components/wallet/wallet-parts";
import { requireAdminPage } from "@/lib/server/admin";
import { getIssueCase } from "@/lib/server/admin-queues";
import { formatKobo } from "@/lib/wallet/money";

export const metadata: Metadata = { title: "Order issue" };

// One reported order issue: what the buyer said, where the money stands,
// the close form while it's open, and its history. Nothing here refunds,
// pays or moves money; closing only releases the seller's held earning.
export default async function IssuePage({ params }: { params: Promise<{ number: string }> }) {
  await requireAdminPage();
  const found = await getIssueCase((await params).number);
  if (!found) notFound();
  const { case: c, history } = found;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title={c.orderNumber} back={<BackLink href="/admin/issues" />} />
      <div className="flex flex-1 flex-col gap-5 px-5 pb-8">
        <Facts
          label="Issue"
          rows={[
            ["Status", c.open ? <Pill key="s" tone="waiting">Open</Pill> : <Pill key="s" tone="good">Closed</Pill>],
            ["Reported", formatDate(c.reportedAt, true)],
            ["Buyer's note", c.note],
            ["Buyer", c.buyerName],
            ["Seller", c.sellerName],
            ...(c.closedAt ? [["Closed", formatDate(c.closedAt, true)] as [string, string]] : []),
            ...(c.resolutionNote ? [["Resolution note", c.resolutionNote] as [string, string]] : []),
          ]}
        />
        <Facts
          label="Order and money"
          rows={[
            ["Order total", formatKobo(c.totalKobo)],
            ["Payment", humanize(c.paymentStatus)],
            ["Delivery", humanize(c.fulfillmentStatus)],
            ["Refunded", c.refundedKobo ? formatKobo(c.refundedKobo) : "Nothing"],
            ["Refund in progress", c.refundPendingKobo ? formatKobo(c.refundPendingKobo) : "None"],
            ["Seller's earning", c.earningHeld ? "Held for review" : "Not held"],
          ]}
        />

        {c.open && <CloseIssueForm orderNumber={c.orderNumber} />}

        <section aria-labelledby="history-heading">
          <h2 id="history-heading" className="mb-2 text-sm font-semibold">
            Admin history
          </h2>
          {history.length ? (
            <AuditList entries={history} />
          ) : (
            <p className="text-sm text-muted-foreground">No admin actions recorded yet.</p>
          )}
        </section>
      </div>
    </main>
  );
}
