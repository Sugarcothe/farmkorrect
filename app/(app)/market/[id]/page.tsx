import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BuyForm } from "@/components/orders/buy-form";
import { categoryLabel, unitLabel } from "@/components/orders/order-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { ProductReviews, ReviewsUnavailable } from "@/components/reviews/product-reviews";
import { Icon } from "@/components/ui/icons";
import { first } from "@/components/wallet/wallet-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { findMarketProduct } from "@/lib/server/products";
import { findProductReviews } from "@/lib/server/reviews";
import { formatKobo } from "@/lib/wallet/money";

export const metadata: Metadata = { title: "Product" };

/** ?reviews= (1-based) pages through the product's reviews. */
function reviewPage(value: string | undefined): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 1 && n < 10_000 ? n : 1;
}

/** The product's reviews, or null if they couldn't be read (the product page still loads). */
async function loadReviews(viewerId: Parameters<typeof findProductReviews>[0], id: string, page: number) {
  try {
    return await findProductReviews(viewerId, id, page);
  } catch (error) {
    console.error(`[product-reviews] failed: ${error instanceof Error ? error.name : typeof error}`);
    return null;
  }
}

export default async function MarketProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const product = await findMarketProduct(user._id, (await params).id);
  if (!product) notFound();
  const reviews = await loadReviews(user._id, product.id, reviewPage(first((await searchParams).reviews)));

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Product" back={<BackLink href="/market" />} />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8">
        <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-foreground/5">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/8 text-primary">
            <Icon name="egg" className="size-6" />
          </span>
          <h2 className="mt-3 text-xl font-semibold tracking-tight">{product.name}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {categoryLabel(product.category)} · sold by {product.own ? "you" : product.sellerName}
          </p>
          <p className="mt-3 text-2xl font-bold tabular-nums text-primary">
            {formatKobo(product.priceKobo)}{" "}
            <span className="text-sm font-medium text-muted-foreground">{unitLabel(product.unit)}</span>
          </p>
          {product.description && (
            <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-foreground/75">{product.description}</p>
          )}
        </section>
        <BuyForm product={product} />
        {reviews ? <ProductReviews productId={product.id} {...reviews} /> : <ReviewsUnavailable productId={product.id} />}
      </div>
    </main>
  );
}
