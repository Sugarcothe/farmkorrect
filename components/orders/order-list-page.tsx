import { OrderRow } from "@/components/orders/order-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { EmptyList, ListCard, Pager } from "@/components/wallet/wallet-parts";
import type { OrderSummary } from "@/lib/orders/types";

/** The buyer's orders or the seller's sales: one paged list, newest first. */
export function OrderListPage({
  viewer,
  orders,
  page,
  hasMore,
}: {
  viewer: "buyer" | "seller";
  orders: OrderSummary[];
  page: number;
  hasMore: boolean;
}) {
  const base = viewer === "buyer" ? "/orders" : "/sales";
  const pageHref = (n: number) => (n > 1 ? `${base}?page=${n}` : base);
  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title={viewer === "buyer" ? "My Orders" : "Sales"} back={<BackLink href="/market" />} />
      <div className="flex flex-1 flex-col px-5 pb-8">
        {orders.length ? (
          <ListCard label={viewer === "buyer" ? "Your orders" : "Orders for your products"}>
            {orders.map((o) => (
              <OrderRow key={o.id} order={o} href={`${base}/${o.id}`} />
            ))}
          </ListCard>
        ) : (
          <EmptyList icon={viewer === "buyer" ? "list" : "wallet"} title={page > 1 ? "No older orders" : "No orders yet"}>
            {viewer === "buyer"
              ? "Orders you place in the Market will be listed here."
              : "When buyers order your listings, they'll appear here. Accept paid orders and mark them delivered."}
          </EmptyList>
        )}
        <Pager newer={page > 1 ? pageHref(page - 1) : null} older={hasMore ? pageHref(page + 1) : null} />
      </div>
    </main>
  );
}

export function pageNumber(value: string | string[] | undefined): number {
  const n = Number(typeof value === "string" ? value : undefined);
  return Number.isSafeInteger(n) && n > 1 && n < 10_000 ? n : 1;
}
