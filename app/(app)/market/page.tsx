import type { Metadata } from "next";
import Link from "next/link";
import { categoryLabel, unitLabel } from "@/components/orders/order-parts";
import { ProfileTopBar } from "@/components/profile/profile-parts";
import { Icon } from "@/components/ui/icons";
import { EmptyList, first, Pager } from "@/components/wallet/wallet-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { listMarket, SELLER_ROLE } from "@/lib/server/products";
import { formatKobo } from "@/lib/wallet/money";

export const metadata: Metadata = { title: "Market" };

const pageHref = (page: number) => (page > 1 ? `/market?page=${page}` : "/market");

// Listings from poultry farmers that are in stock, read straight from the
// database. Prices shown here are re-read on the server when an order is placed.
export default async function MarketPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const requested = Number(first((await searchParams).page));
  const page = Number.isSafeInteger(requested) && requested > 1 && requested < 10_000 ? requested : 1;
  const { products, hasMore } = await listMarket(user._id, page);
  const isSeller = user.role === SELLER_ROLE;

  const shortcut =
    "flex flex-1 items-center justify-center gap-1.5 rounded-full bg-white px-3 py-2.5 text-[0.8125rem] font-medium text-primary ring-1 ring-foreground/8 outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Market" />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <nav aria-label="Your Market activity" className="mb-4 flex gap-2">
          <Link href="/orders" className={shortcut}>
            <Icon name="list" className="size-4" />
            My orders
          </Link>
          {isSeller && (
            <>
              <Link href="/market/listings" className={shortcut}>
                <Icon name="store" className="size-4" />
                My listings
              </Link>
              <Link href="/sales" className={shortcut}>
                <Icon name="wallet" className="size-4" />
                Sales
              </Link>
            </>
          )}
        </nav>

        {products.length ? (
          <ul aria-label="Products" className="grid grid-cols-2 gap-3">
            {products.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/market/${p.id}`}
                  className="flex h-full flex-col rounded-3xl bg-white p-3.5 shadow-sm ring-1 ring-foreground/5 outline-none hover:ring-primary/30 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="flex size-10 items-center justify-center rounded-2xl bg-primary/8 text-primary">
                    <Icon name="egg" className="size-5" />
                  </span>
                  <span className="mt-2.5 line-clamp-2 text-sm font-semibold">{p.name}</span>
                  <span className="mt-0.5 text-[0.6875rem] text-muted-foreground">{categoryLabel(p.category)}</span>
                  <span className="mt-auto pt-2 text-sm font-semibold tabular-nums text-primary">{formatKobo(p.priceKobo)}</span>
                  <span className="text-[0.6875rem] text-muted-foreground">{unitLabel(p.unit)}</span>
                  <span className="mt-1 truncate text-[0.6875rem] text-foreground/60">
                    {p.own ? "Your listing" : p.sellerName}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyList icon="store" title={page > 1 ? "No more products" : "Nothing for sale yet"}>
            {isSeller
              ? "Products farmers list will appear here. List your own eggs, birds or produce from My listings."
              : "Products poultry farmers list will appear here."}
          </EmptyList>
        )}
        <Pager newer={page > 1 ? pageHref(page - 1) : null} older={hasMore ? pageHref(page + 1) : null} />
      </div>
    </main>
  );
}
