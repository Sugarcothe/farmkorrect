import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { MarketFilters } from "@/components/market/market-filters";
import { ActiveFilters, CategoryChips, MarketPager } from "@/components/market/market-parts";
import { MarketSearch } from "@/components/market/market-search";
import { ProductCard } from "@/components/market/product-card";
import { ProfileTopBar } from "@/components/profile/profile-parts";
import { Icon } from "@/components/ui/icons";
import { EmptyList } from "@/components/wallet/wallet-parts";
import { stateLabel } from "@/lib/locations/nigeria";
import { activeFilters, marketHref, parseMarketQuery } from "@/lib/market/query";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { trySearchMarket, type MarketResults } from "@/lib/server/market";
import { SELLER_ROLE } from "@/lib/server/products";

export const metadata: Metadata = { title: "Market" };

type RawParams = Record<string, string | string[] | undefined>;

/** The address as it was asked for, to compare with its canonical form. */
function requestedHref(params: RawParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) search.append(key, v);
  const s = search.toString();
  return s ? `/market?${s}` : "/market";
}

function resultCount(results: MarketResults) {
  if (results.totalCapped) return `${results.total.toLocaleString("en-NG")}+ products`;
  return `${results.total.toLocaleString("en-NG")} ${results.total === 1 ? "product" : "products"}`;
}

// Listings from poultry farmers, searched and filtered in the database (see
// lib/server/market.ts). Everything about the search lives in the address, so
// it survives a refresh, can be shared, and Back/Forward step through it.
// Prices shown here are re-read on the server when an order is placed.
export default async function MarketPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const { user } = await requireVerifiedPageSession();
  const params = await searchParams;
  const query = parseMarketQuery(params);
  // Unknown, invalid or out-of-order values: show the address that matches what's on screen.
  const canonical = marketHref(query);
  if (canonical !== requestedHref(params)) redirect(canonical);

  const results = await trySearchMarket(user._id, query);
  const isSeller = user.role === SELLER_ROLE;
  const filtered = activeFilters(query).length > 0;

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

        <div className="flex flex-col gap-3">
          <MarketSearch query={query} />
          <CategoryChips query={query} />
          <MarketFilters query={query} />
          <ActiveFilters query={query} />
        </div>

        <div className="mt-4 mb-3" aria-live="polite">
          {results && (
            <p className="text-xs text-muted-foreground">
              {resultCount(results)}
              {query.near && results.total > 0 && ` · ${stateLabel(query.near)} first`}
            </p>
          )}
        </div>

        {!results ? (
          <div role="alert" className="flex flex-col items-center rounded-3xl bg-white px-6 py-10 text-center shadow-sm ring-1 ring-foreground/5">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-red-50 text-red-700">
              <Icon name="alert-circle" className="size-7" />
            </div>
            <h3 className="mt-4 text-base font-semibold">Couldn&rsquo;t load products</h3>
            <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted-foreground">
              Something went wrong on our side. Your search and filters are kept.
            </p>
            <Link
              href={canonical}
              className="mt-4 flex h-10 items-center rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Try again
            </Link>
          </div>
        ) : results.products.length ? (
          <ul aria-label="Products" className="grid grid-cols-2 gap-3">
            {results.products.map((p) => (
              <li key={p.id}>
                <ProductCard product={p} />
              </li>
            ))}
          </ul>
        ) : query.page > 1 ? (
          <EmptyList icon="store" title="No more products">
            <Link href={marketHref({ ...query, page: 1 })} className="font-medium text-primary underline-offset-2 hover:underline">
              Back to the first page
            </Link>
          </EmptyList>
        ) : filtered ? (
          <EmptyList icon="search" title="No products match your search">
            Try fewer words or filters.{" "}
            <Link href="/market" className="font-medium text-primary underline-offset-2 hover:underline">
              Clear search and filters
            </Link>
          </EmptyList>
        ) : (
          <EmptyList icon="store" title="Nothing for sale yet">
            {isSeller
              ? "Products farmers list will appear here. List your own eggs, birds or produce from My listings."
              : "Products poultry farmers list will appear here."}
          </EmptyList>
        )}
        {results && <MarketPager query={query} hasMore={results.hasMore} />}
      </div>
    </main>
  );
}
