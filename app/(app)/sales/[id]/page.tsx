import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DeliveryNote, IssueNotice, OrderHeader, OrderHistory, OrderItems } from "@/components/orders/order-parts";
import { SellerActions } from "@/components/orders/seller-actions";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { toOrder } from "@/lib/server/order-store";
import { findOrderFor } from "@/lib/server/orders";

export const metadata: Metadata = { title: "Sale" };

// An order for one of the signed-in seller's products. The buyer's phone and
// email are never shown; the delivery details are what the buyer wrote.
export default async function SalePage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireVerifiedPageSession();
  const doc = await findOrderFor(user._id, (await params).id, "seller");
  if (!doc) notFound();
  const order = toOrder(doc, "seller");
  const unpaid = order.paymentStatus === "pending" || order.paymentStatus === "failed";

  return (
    <main data-wide="md" className="flex flex-1 flex-col">
      <ProfileTopBar title="Sale" back={<BackLink href="/sales" />} />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8 md:px-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start lg:gap-6">
        <div className="flex flex-col gap-4 lg:sticky lg:top-6">
          <OrderHeader order={order} />
          <IssueNotice order={order} />
          {unpaid && order.fulfillmentStatus === "pending" && (
            <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900">
              Waiting for the buyer to pay. Don&apos;t send anything until this shows as Paid.
            </p>
          )}
          <SellerActions order={order} />
        </div>
        <div className="flex flex-col gap-4">
          <OrderItems order={order} />
          <DeliveryNote order={order} />
          <OrderHistory order={order} />
        </div>
      </div>
    </main>
  );
}
