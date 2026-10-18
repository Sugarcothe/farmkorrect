import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { ProductPhoto } from "@/components/market/product-photo";
import { categoryLabel, unitLabel } from "@/components/orders/order-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { EmptyList, first, ListCard } from "@/components/wallet/wallet-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { listOwnProducts, SELLER_ROLE } from "@/lib/server/products";
import { formatKobo } from "@/lib/wallet/money";

export const metadata: Metadata = { title: "My Listings" };

const SAVED_NOTICE: Record<string, string> = {
  added: "Listing added to the Market.",
  updated: "Changes saved.",
  removed: "Listing removed from the Market.",
};

// The signed-in farmer's own listings, read from the database.
export default async function ListingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  if (user.role !== SELLER_ROLE) redirect("/market");
  const products = await listOwnProducts(user._id);
  const saved = first((await searchParams).saved);
  const notice = saved && Object.hasOwn(SAVED_NOTICE, saved) ? SAVED_NOTICE[saved] : null;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="My Listings" back={<BackLink href="/market" />} />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8">
        {notice && <FormAlert tone="success">{notice}</FormAlert>}
        <Link href="/market/listings/new" className={buttonClasses("solid", "gap-2")}>
          <Icon name="plus" className="size-5" />
          New listing
        </Link>
        <Link href="/market/promotions" className={buttonClasses("outline")}>
          Promotions &amp; coupon codes
        </Link>
        <Link href="/market/insights" className={buttonClasses("outline")}>
          Sales insights
        </Link>
        {products.length ? (
          <ListCard label="Your listings">
            {products.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/market/listings/${p.id}/edit`}
                  className="flex items-center gap-3 px-4 py-3.5 outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
                >
                  <span className="relative size-12 shrink-0 overflow-hidden rounded-xl bg-primary/8">
                    <ProductPhoto image={p.images[0]} alt={p.name} width={160} sizes="48px" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {categoryLabel(p.category)} · {formatKobo(p.priceKobo)} {unitLabel(p.unit)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
                    <span className={p.stockQuantity === 0 ? "font-semibold text-red-700" : "text-foreground/70"}>
                      {p.stockQuantity === 0 ? "Sold out" : `${p.stockQuantity} in stock`}
                    </span>
                    {!p.active && <span className="rounded-full bg-foreground/6 px-2 py-0.5 font-semibold text-foreground/60">Hidden</span>}
                  </div>
                  <Icon name="chevron-right" className="size-[18px] text-foreground/35" />
                </Link>
              </li>
            ))}
          </ListCard>
        ) : (
          <EmptyList icon="store" title="No listings yet">
            List eggs, birds or other produce. Buyers pay through Paystack before you deliver.
          </EmptyList>
        )}
      </div>
    </main>
  );
}
