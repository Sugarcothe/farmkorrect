import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OfferPrice, OfferTerms } from "@/components/market/offer-parts";
import { productPlace } from "@/components/market/product-card";
import { ProductGallery } from "@/components/market/product-gallery";
import { BuyForm } from "@/components/orders/buy-form";
import { FulfillmentOptions } from "@/components/orders/fulfillment-parts";
import { categoryLabel, unitLabel } from "@/components/orders/order-parts";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { ProductReviews, ReviewsUnavailable } from "@/components/reviews/product-reviews";
import { Icon } from "@/components/ui/icons";
import { first } from "@/components/wallet/wallet-parts";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { findMarketProduct } from "@/lib/server/products";
import { findProductReviews } from "@/lib/server/reviews";

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
  const place = productPlace(product);
  const reviews = await loadReviews(user._id, product.id, reviewPage(first((await searchParams).reviews)));

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Product" back={<BackLink href="/market" />} />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8">
        <ProductGallery name={product.name} images={product.images} />
        <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-foreground/5">
          <h2 className="text-xl font-semibold tracking-tight">{product.name}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {categoryLabel(product.category)} · sold by {product.own ? "you" : product.sellerName}
          </p>
          {place && (
            <p className="mt-1 flex items-center gap-1 text-xs text-foreground/60">
              <Icon name="map-pin" className="size-3.5 shrink-0" />
              {place}
            </p>
          )}
          <p className="mt-3 text-2xl font-bold tabular-nums text-primary">
            <OfferPrice priceKobo={product.priceKobo} offer={product.offer} />{" "}
            <span className="text-sm font-medium text-muted-foreground">{unitLabel(product.unit)}</span>
          </p>
          {product.offer && <OfferTerms offer={product.offer} />}
          {product.description && (
            <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-foreground/75">{product.description}</p>
          )}
        </section>
        <FulfillmentOptions fulfillment={product.fulfillment} />
        <BuyForm product={product} />
        {reviews ? <ProductReviews productId={product.id} {...reviews} /> : <ReviewsUnavailable productId={product.id} />}
      </div>
    </main>
  );
}
