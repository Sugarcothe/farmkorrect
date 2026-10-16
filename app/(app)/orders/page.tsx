import type { Metadata } from "next";
import { OrderListPage, pageNumber } from "@/components/orders/order-list-page";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { toOrderSummary } from "@/lib/server/order-store";
import { listOrders } from "@/lib/server/orders";
import { PAGE_SIZE } from "@/lib/server/wallet";

export const metadata: Metadata = { title: "My Orders" };

// The signed-in user's orders as a buyer, read from the database.
export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const page = pageNumber((await searchParams).page);
  const { orders, hasMore } = await listOrders(user._id, "buyer", { page, pageSize: PAGE_SIZE });
  return <OrderListPage viewer="buyer" orders={orders.map((o) => toOrderSummary(o, "buyer"))} page={page} hasMore={hasMore} />;
}
