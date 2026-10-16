import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BuyerActions } from "@/components/orders/buyer-actions";
import { DeliveryNote, IssueNotice, OrderHeader, OrderHistory, OrderItems } from "@/components/orders/order-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { first } from "@/components/wallet/wallet-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { PAYMENT_REFERENCE } from "@/lib/server/order-payments";
import { toOrder } from "@/lib/server/order-store";
import { findOrderFor } from "@/lib/server/orders";

export const metadata: Metadata = { title: "Order" };

// One of the signed-in buyer's orders. Paystack sends the buyer back here
// with ?reference=…; that only prompts a server-side check with Paystack,
// it never marks anything paid by itself.
export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const doc = await findOrderFor(user._id, (await params).id, "buyer");
  if (!doc) notFound();
  const order = toOrder(doc, "buyer");
  const query = await searchParams;
  const returned = first(query.reference) ?? first(query.trxref) ?? null;
  const reference = returned && PAYMENT_REFERENCE.test(returned) ? returned : null;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Order" back={<BackLink href="/orders" />} />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8">
        <OrderHeader order={order} />
        <IssueNotice order={order} />
        <BuyerActions order={order} returnedReference={reference} />
        <OrderItems order={order} />
        <DeliveryNote order={order} />
        <OrderHistory order={order} />
      </div>
    </main>
  );
}
